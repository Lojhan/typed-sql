import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { analyzeSchemaCompatibility, parseQueryManifest } from "@typed-sql/compiler";
import type { LoadedConfig } from "@typed-sql/config";
import type { SchemaSnapshot } from "@typed-sql/core";
import {
  digest,
  ensureDirectory,
  loadInventory,
  MigrationError,
  type MigrationsConfig,
  replayEvidence,
  safePath,
} from "@typed-sql/migrations";
import { calculateSchemaHash, parseSchemaSnapshot, serializeSchemaSnapshot } from "@typed-sql/schema";

/** Verify both application revisions against independently replayed migration boundaries. */
export async function verifyMigrationCompatibility(options: {
  readonly loaded: LoadedConfig;
  readonly migrations: MigrationsConfig;
  readonly target: string;
  readonly flags: Readonly<Record<string, string>>;
}): Promise<unknown> {
  const { loaded, migrations, flags } = options,
    root = loaded.directory;
  const captureDirectory = flags["capture-dir"];
  const failOn = flags["fail-on"] ?? loaded.config.compatibility?.failOn ?? "error";
  if (!["none", "warning", "error"].includes(failOn))
    throw new MigrationError("MIGRATION_VERIFY_POLICY", "--fail-on must be none, warning or error.", 2);
  for (const key of captureDirectory === undefined
    ? ["before", "after", "before-manifest", "after-manifest", "before-through"]
    : ["before-through"])
    if (!flags[key])
      throw new MigrationError(
        "MIGRATION_VERIFY_INPUTS",
        `migrate verify requires --${key}; both application revisions and an explicit before boundary are required.`,
        2,
      );
  const target = migrations.targets[options.target];
  if (!target?.disposable || target.classification === "production")
    throw new MigrationError(
      "MIGRATION_VERIFY_TARGET",
      "Verify executes only in an explicitly disposable nonproduction target.",
      2,
    );
  const inventory = await loadInventory(root, migrations.directory, loaded.config.dialect);
  let selected = inventory.migrations;
  if (flags.to !== undefined) {
    const index = selected.findIndex((m) => m.id === flags.to);
    if (index < 0) throw new MigrationError("MIGRATION_VERIFY_BOUNDARY", "Unknown --to migration.", 2);
    selected = selected.slice(0, index + 1);
  }
  const beforeBoundary = flags["before-through"]!;
  if (!selected.length || (beforeBoundary !== "empty" && !selected.some((m) => m.id === beforeBoundary)))
    throw new MigrationError(
      "MIGRATION_VERIFY_BOUNDARY",
      "Before boundary must be empty or a migration in the selected replay prefix.",
      2,
    );
  let observedBefore: SchemaSnapshot | undefined, observedAfter: SchemaSnapshot | undefined;
  await replayEvidence(target, selected, undefined, undefined, async (session, id) => {
    if (!session.snapshot)
      throw new MigrationError(
        "MIGRATION_VERIFY_CAPABILITY",
        "The migration adapter cannot capture compiler schema snapshots on its pinned replay connection.",
      );
    if (id === (beforeBoundary === "empty" ? null : beforeBoundary)) observedBefore = await session.snapshot();
    if (id === selected.at(-1)!.id) observedAfter = await session.snapshot();
  });
  if (!observedBefore || !observedAfter)
    throw new MigrationError("MIGRATION_VERIFY_SCHEMA", "Replay did not capture both declared boundaries.", 3);
  if (captureDirectory !== undefined) {
    const directory = await ensureDirectory(root, captureDirectory);
    const beforeFile = join(directory, "before.schema.json"),
      afterFile = join(directory, "after.schema.json");
    await writeFile(beforeFile, serializeSchemaSnapshot(parseSchemaSnapshot(observedBefore), 2), {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(afterFile, serializeSchemaSnapshot(parseSchemaSnapshot(observedAfter), 2), {
      mode: 0o600,
      flag: "wx",
    });
    return {
      formatVersion: 1,
      kind: "typed-sql-migration-capture",
      state: "replayed",
      compatibility: "not-evaluated",
      beforeThrough: beforeBoundary,
      afterThrough: selected.at(-1)!.id,
      migrations: selected.map((m) => ({ id: m.id, hash: m.hash })),
      beforeFile,
      afterFile,
      next: "Build each application revision's manifest against its corresponding captured snapshot, then migrate verify with all four artifacts.",
    };
  }
  const readJson = async (path: string) => JSON.parse(await readFile(await safePath(root, path), "utf8")) as unknown;
  const [beforeRaw, afterRaw, beforeManifestRaw, afterManifestRaw] = await Promise.all(
    ["before", "after", "before-manifest", "after-manifest"].map((key) => readJson(flags[key]!)),
  );
  const before = parseSchemaSnapshot(beforeRaw),
    after = parseSchemaSnapshot(afterRaw),
    beforeManifest = parseQueryManifest(beforeManifestRaw),
    afterManifest = parseQueryManifest(afterManifestRaw);
  if (before.dialect !== loaded.config.dialect.id || after.dialect !== loaded.config.dialect.id)
    throw new MigrationError("MIGRATION_VERIFY_DIALECT", "Verification snapshots must use the configured grammar.", 2);
  if (
    !observedBefore ||
    !observedAfter ||
    calculateSchemaHash(parseSchemaSnapshot(observedBefore)) !== calculateSchemaHash(before) ||
    calculateSchemaHash(parseSchemaSnapshot(observedAfter)) !== calculateSchemaHash(after)
  )
    throw new MigrationError(
      "MIGRATION_VERIFY_SCHEMA",
      "Supplied before/after snapshots do not match the independently replayed migration boundaries; regenerated live drift cannot substitute for replay evidence.",
      3,
    );
  const compatibility = analyzeSchemaCompatibility({ before, after, beforeManifest, afterManifest });
  const report = {
    formatVersion: 1,
    kind: "typed-sql-migration-verification",
    migrations: selected.map((m) => ({ id: m.id, hash: m.hash })),
    beforeThrough: beforeBoundary,
    afterThrough: selected.at(-1)!.id,
    inventoryHash: digest(inventory.files),
    beforeSchemaHash: calculateSchemaHash(before),
    afterSchemaHash: calculateSchemaHash(after),
    beforeManifestHash: digest(beforeManifest),
    afterManifestHash: digest(afterManifest),
    compatibility,
  };
  const file = resolve(root, flags.out ?? ".typed-sql/migrations/verification.json");
  await ensureDirectory(root, dirname(file));
  // Reports are redacted evidence, distinct from executable bundles; replace only a regular prior report.
  try {
    await safePath(root, file);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (
    (failOn === "error" && compatibility.summary.error > 0) ||
    (failOn === "warning" && (compatibility.summary.warning > 0 || compatibility.summary.error > 0))
  )
    process.exitCode = 1;
  return { ...report, reportFile: file };
}
