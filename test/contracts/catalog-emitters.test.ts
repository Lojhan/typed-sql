import { execFile as execFileCallback } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import { addCapture, emptyCorpus } from "../../scripts/catalog-generation/corpus.mjs";
import { generateCatalogs } from "../../scripts/catalog-generation/generate.mjs";
import { cleanCatalogProjections, isCatalogProjection } from "../../scripts/catalog-generation/lifecycle.mjs";
import { CATEGORIES, inventory, unavailable } from "../../scripts/language-audit/inventory.mjs";
import { scalarTypeName } from "../../tools/grammar-catalog/src/generate/duckdb.mjs";
import { routineSignature } from "../../tools/grammar-catalog/src/model/routines.mjs";
import { createMapperRegistry, numericVersionBand } from "../../tools/grammar-catalog/src/registry.mjs";

const execFile = promisify(execFileCallback);
const workspace = fileURLToPath(new URL("../../", import.meta.url));
interface EmitterContext {
  header: string;
  groups: { categories: Record<string, { rows?: { name: string }[] }> }[];
  emit(path: string, text: string): Promise<void>;
  input(key: string, path: string): Promise<unknown>;
}
type Emitter = (context: EmitterContext) => Promise<void>;
const mapper = {
  id: "external",
  versionBand: numericVersionBand(1),
  normalizeRow: (_category: string, row: unknown) => row,
  routineFacts: () => ({ parameters: [], result: "external_type" }),
};
async function fixture(generateCatalog?: Emitter) {
  const registry = createMapperRegistry([{ ...mapper, ...(generateCatalog ? { generateCatalog } : {}) }]);
  const native = { name: "external_function" };
  const row = { ...native, signature: routineSignature(mapper, native) };
  const corpus = emptyCorpus();
  await addCapture(
    corpus,
    {
      dialect: "external",
      target: { version: "1.0.0" },
      categories: Object.fromEntries(
        CATEGORIES.map((name) => [
          name,
          name === "functions" ? inventory([row], "external capture") : unavailable("No fixture observation"),
        ]),
      ),
    },
    registry,
  );
  return { corpus, registry };
}

await describe("registered catalog emitters and clean generation", async () => {
  await it("generates an external grammar deterministically through the shared runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "typed-sql-emitter-"));
    try {
      await writeFile(join(root, "policy.json"), JSON.stringify({ policy: "external" }));
      const { corpus, registry } = await fixture(async ({ groups, emit, input, header }) => {
        const names = groups.flatMap((group) => group.categories.functions?.rows ?? []).map((row) => row.name);
        const policy = await input("policy", "policy.json");
        await emit("generated/catalog.mjs", `${header}export const catalog = ${JSON.stringify({ names, policy })};\n`);
      });
      const options = { root, registry };
      const first = await generateCatalogs(corpus, options);
      strict.ok(first.changed.includes("generated/catalog.mjs"));
      const generated = await readFile(join(root, "generated/catalog.mjs"), "utf8");
      strict.ok(generated.includes("external_function"));
      strict.ok(generated.includes('"policy":"external"'));
      strict.deepEqual((await generateCatalogs(corpus, { ...options, check: true })).changed, []);
      const report = JSON.parse(await readFile(join(root, "grammar/catalog/generation.json"), "utf8"));
      strict.equal(report.outputDigestFormat, "utf8-bytes-sha256");
      strict.match(report.outputDigests["generated/catalog.mjs"], /^sha256:[a-f0-9]{64}$/u);
      await writeFile(join(root, "generated/catalog.mjs"), "changed by hand");
      await strict.rejects(generateCatalogs(corpus, { ...options, check: true }), /stale/u);
      strict.equal(await readFile(join(root, "generated/catalog.mjs"), "utf8"), "changed by hand");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await it("validates all contributions before writing and rejects conflicting or reserved ownership", async () => {
    for (const behavior of [
      "failure",
      "duplicate",
      "case-collision",
      "report",
      "schema",
      "escape",
      "absolute",
      "missing",
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "typed-sql-emitter-invalid-"));
      try {
        const { corpus, registry } = await fixture(
          behavior === "missing"
            ? undefined
            : async ({ emit }) => {
                await emit("generated/value.mjs", "export const value = 1;\n");
                if (behavior === "failure") throw new Error("Invalid mapping contribution");
                const path = {
                  duplicate: "generated/value.mjs",
                  "case-collision": "generated/VALUE.mjs",
                  report: "grammar/catalog/generation.json",
                  schema: "grammar/catalog/format.schema.json",
                  escape: "../outside.mjs",
                  absolute: "/outside.mjs",
                }[behavior];
                await emit(path, "invalid ownership");
              },
        );
        await strict.rejects(
          generateCatalogs(corpus, { root, registry }),
          /mapping contribution|multiple emitters|workspace|Missing catalog emitter/u,
        );
        strict.deepEqual(await readdir(root), [], behavior);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  await it("uses fresh captured scalar aliases without reading a generated parser", () => {
    strict.equal(scalarTypeName("new_alias", { NEW_ALIAS: "FRESH_NATIVE_TYPE" }, {}), "FRESH_NATIVE_TYPE");
    strict.equal(scalarTypeName("DECIMAL(18,3)", {}, {}), "DECIMAL");
    strict.equal(scalarTypeName("TIME WITH TIME ZONE", {}, { "TIME WITH TIME ZONE": "TIMETZ" }), "TIMETZ");
    for (const source of ["DECIMAL(39,0)", "DECIMAL(2,3)", "INTEGER[]", "MAP(INTEGER,VARCHAR)", "int);DROP TABLE t"])
      strict.throws(() => scalarTypeName(source, {}, {}), /endpoint/u);
  });

  await it("materializes only missing projections after validating every durable input and existing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "typed-sql-materialize-"));
    const projection = "packages/external/src/catalog/generated/functions.ts";
    try {
      const { corpus, registry } = await fixture(async ({ emit, header }) => {
        await emit(projection, `${header}export const names = ["external_function"];\n`);
      });
      const options = { root, registry };
      await generateCatalogs(corpus, options);
      const before = await readFile(join(root, projection));
      const report = await readFile(join(root, "grammar/catalog/generation.json"));
      const durable = await readFile(join(root, "grammar/catalog/format.schema.json"));
      await cleanCatalogProjections(root);
      await strict.rejects(generateCatalogs(corpus, { ...options, check: true }), /stale/u);
      await writeFile(join(root, "grammar/catalog/format.schema.json"), "changed durable source");
      await strict.rejects(generateCatalogs(corpus, { ...options, check: true, materialize: true }), /stale/u);
      await strict.rejects(access(join(root, projection)), { code: "ENOENT" });
      await writeFile(join(root, "grammar/catalog/format.schema.json"), durable);
      const result = await generateCatalogs(corpus, { ...options, check: true, materialize: true });
      strict.deepEqual(result.materialized, [projection]);
      strict.deepEqual(await readFile(join(root, projection)), before);
      strict.deepEqual(await readFile(join(root, "grammar/catalog/generation.json")), report);
      await writeFile(join(root, projection), "changed projection");
      await strict.rejects(generateCatalogs(corpus, { ...options, check: true, materialize: true }), /stale/u);
      strict.equal(await readFile(join(root, projection), "utf8"), "changed projection");
      await strict.rejects(cleanCatalogProjections(root), /refusing removal/u);
      await writeFile(join(root, projection), before);
      // UTF-8 replacement decoding must not make changed bytes appear canonical.
      await writeFile(join(root, projection), Buffer.concat([before, Buffer.from([0xff])]));
      await strict.rejects(generateCatalogs(corpus, { ...options, check: true, materialize: true }), /stale/u);
      await writeFile(join(root, projection), before);
      await cleanCatalogProjections(root);
      const concurrent = await Promise.all([
        generateCatalogs(corpus, { ...options, check: true, materialize: true }),
        generateCatalogs(corpus, { ...options, check: true, materialize: true }),
      ]);
      strict.equal(concurrent.length, 2);
      strict.deepEqual(await readFile(join(root, projection)), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await it("retires only unchanged previously owned projections and preserves authored neighbors", async () => {
    const root = await mkdtemp(join(tmpdir(), "typed-sql-retired-projection-"));
    let retired = false;
    const oldPath = "packages/external/src/catalog/generated/old.ts",
      newPath = "packages/external/src/catalog/generated/current.ts";
    try {
      const { corpus, registry } = await fixture(async ({ emit, header }) => {
        if (!retired) await emit(oldPath, `${header}export const oldValue = 1;\n`);
        await emit(newPath, `${header}export const currentValue = 2;\n`);
      });
      const options = { root, registry };
      await generateCatalogs(corpus, options);
      const original = await readFile(join(root, oldPath));
      await writeFile(join(root, "packages/external/src/catalog/generated/authored.ts"), "// authored neighbor\n");
      retired = true;
      await strict.rejects(generateCatalogs(corpus, { ...options, check: true, materialize: true }), /stale/u);
      await writeFile(join(root, oldPath), "// changed by hand\n");
      await strict.rejects(generateCatalogs(corpus, options), /refusing removal/u);
      await writeFile(join(root, oldPath), original);
      strict.deepEqual((await generateCatalogs(corpus, options)).retired, [oldPath]);
      await strict.rejects(access(join(root, oldPath)), { code: "ENOENT" });
      strict.equal(
        await readFile(join(root, "packages/external/src/catalog/generated/authored.ts"), "utf8"),
        "// authored neighbor\n",
      );
      await cleanCatalogProjections(root);
      await strict.rejects(access(join(root, newPath)), { code: "ENOENT" });
      await access(join(root, "packages/external/src/catalog/generated/authored.ts"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await it("refuses projection paths through symbolic links before materialization or cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "typed-sql-projection-link-"));
    const outside = await mkdtemp(join(tmpdir(), "typed-sql-projection-outside-"));
    try {
      const projection = "packages/external/src/catalog/generated/value.ts";
      const { corpus, registry } = await fixture(async ({ emit, header }) => {
        await emit(projection, `${header}export const value = 1;\n`);
      });
      const options = { root, registry };
      await generateCatalogs(corpus, options);
      await cleanCatalogProjections(root);
      const generated = join(root, "packages/external/src/catalog/generated");
      await rm(generated, { recursive: true });
      await symlink(outside, generated, "junction");
      await strict.rejects(generateCatalogs(corpus, { ...options, check: true, materialize: true }), /symbolic link/u);
      await strict.rejects(cleanCatalogProjections(root), /symbolic link/u);
      strict.deepEqual(await readdir(outside), []);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  await it("keeps all owned package projections ignored and untracked while maintaining grammar source", async () => {
    const report = JSON.parse(await readFile(join(workspace, "grammar/catalog/generation.json"), "utf8"));
    const projections: string[] = report.outputs.filter(isCatalogProjection);
    strict.ok(projections.length > 0);
    const tracked = await execFile("git", ["ls-files", "--", ...projections], { cwd: workspace });
    strict.equal(tracked.stdout, "");
    const ignored = await execFile("git", ["check-ignore", "--no-index", "--", ...projections], { cwd: workspace });
    strict.deepEqual(ignored.stdout.trim().split("\n").sort(), projections.toSorted());
    const maintained = [...new Set(projections.map((path) => path.split("/").slice(0, 2).join("/")))].map(
      (path) => `${path}/src/index.ts`,
    );
    await strict.rejects(
      execFile("git", ["check-ignore", "--no-index", "--", ...maintained], { cwd: workspace }),
      (error: unknown) =>
        (error as { code?: number; stdout?: string }).code === 1 && (error as { stdout?: string }).stdout === "",
    );
    const facts = await execFile("git", ["ls-files", "--", "grammar/catalog/upstream.json"], { cwd: workspace });
    strict.equal(facts.stdout.trim(), "grammar/catalog/upstream.json");
  });

  await it("bootstraps all current outputs without grammar implementations or previously generated code", async () => {
    const root = await mkdtemp(join(tmpdir(), "typed-sql-catalog-bootstrap-"));
    try {
      for (const path of [
        "tools/grammar-catalog/src",
        "scripts/catalog-generation",
        "scripts/language-audit",
        "grammar",
      ])
        await cp(join(workspace, path), join(root, path), { recursive: true });
      await cp(join(workspace, "tools/grammar-catalog/package.json"), join(root, "tools/grammar-catalog/package.json"));
      const dependency = join(root, "tools/grammar-catalog/node_modules/@sinclair/typebox");
      await mkdir(dirname(dependency), { recursive: true });
      await symlink(
        await realpath(join(workspace, "tools/grammar-catalog/node_modules/@sinclair/typebox")),
        dependency,
        "junction",
      );
      await strict.rejects(access(join(root, "packages")), { code: "ENOENT" });
      await rm(join(root, "grammar/catalog/format.schema.json"));
      await rm(join(root, "grammar/catalog/generation.json"));
      const references = join(workspace, "test/fixtures/language-audit");
      for (const reference of (await readdir(references)).filter((name) => name.startsWith("sqlite-reference-"))) {
        const destination = join(root, "test/fixtures/language-audit", reference);
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(references, reference), destination);
      }
      for (const mode of ["generate", "check"])
        await execFile(process.execPath, ["scripts/catalog-generation/run.mjs", mode], { cwd: root, timeout: 90_000 });
      const report = JSON.parse(await readFile(join(root, "grammar/catalog/generation.json"), "utf8"));
      for (const path of report.outputs) await access(join(root, path));
      const removed = await cleanCatalogProjections(root);
      strict.ok(removed.length > 0);
      await execFile(process.execPath, ["scripts/catalog-generation/run.mjs", "materialize"], {
        cwd: root,
        timeout: 90_000,
      });
      for (const path of removed) await access(join(root, path));
      strict.deepEqual(JSON.parse(await readFile(join(root, "grammar/catalog/generation.json"), "utf8")), report);

      const corpus = JSON.parse(await readFile(join(root, "grammar/catalog/upstream.json"), "utf8"));
      strict.equal(report.model.profiles, Object.keys(corpus.targets).length);
      await strict.rejects(access(join(root, "packages/duckdb/src/native-types.ts")), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
