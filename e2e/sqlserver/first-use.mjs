import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { consumer } from "../build/src/consumer.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const artifacts = resolve(directory, "../../artifacts/sqlserver");
const offlineCommands = [
  ["pnpm", ["exec", "typed-sql", "generate"]],
  ["pnpm", ["exec", "typed-sql-build", "types"]],
  ["pnpm", ["exec", "typed-sql-build", "types", "--check"]],
  ["pnpm", ["exec", "typed-sql", "check", "--project", "tsconfig.json", "--show-types"]],
  ["pnpm", ["exec", "typed-sql", "manifest"]],
  ["pnpm", ["exec", "tsc", "--noEmit"]],
  [process.execPath, ["build.mjs"]],
];
async function prepare(project) {
  await cp(join(directory, "project"), project, { recursive: true });
  await cp(resolve(directory, "../../examples/sqlserver/schema/001-schema.sql"), join(project, "schema.sql"));
}
export async function replayOffline(fixture, project, environment) {
  let transcript = "";
  for (const [program, args] of offlineCommands) {
    const result = await fixture.command(project, program, args, { env: environment });
    transcript += `$ ${program} ${args.join(" ")}\n${result.output}\n`;
    // Neither SDK import nor pool acquisition is legitimate in these offline commands.
    await assert.rejects(access(join(project, "native-imports.log")), (error) => error.code === "ENOENT");
  }
  assert.match(await readFile(join(project, "find.d.sql.ts"), "utf8"), /"id": bigint/u);
  const source = join(project, "inline.ts");
  const valid = await readFile(source, "utf8");
  try {
    // Replay the tutorial's error boundary, then restore the valid application.
    await writeFile(
      source,
      `${valid}\nconst wrongId = "1";\nexport const wrongAccount = sql\`SELECT id FROM dbo.users WHERE id = \${wrongId}\`;\n`,
    );
    const rejected = await fixture.command(
      project,
      "pnpm",
      ["exec", "typed-sql", "check", "--project", "tsconfig.json"],
      { env: environment, allowFailure: true },
    );
    assert.notEqual(rejected.code, 0, "String interpolation must fail the bigint predicate contract");
    assert.match(rejected.output, /TS2345/u);
    assert.match(rejected.output, /bigint/u);
    transcript += `$ typed-sql check (deliberate tutorial mismatch)\n${rejected.output}\n`;
    await assert.rejects(access(join(project, "native-imports.log")), (error) => error.code === "ENOENT");
  } finally {
    await writeFile(source, valid);
  }
  return transcript;
}
async function replayNativeServices(fixture, project, environment, save) {
  const auditFile = join(project, "native-imports.log");
  await rm(auditFile, { force: true });
  const command = (args) =>
    fixture.command(project, "pnpm", ["exec", "typed-sql", ...args], { env: environment, allowFailure: true });
  const audit = async (stage) => {
    const text = await readFile(auditFile, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    await save(`${stage}-sdk-imports`, text);
    const entries = text.trimEnd().split("\n");
    assert.ok(
      text.length > 0 && entries.every((entry) => entry === "SDK initialized"),
      `${stage} must initialize the application-owned SDK`,
    );
    await rm(auditFile);
    return entries.length;
  };
  const manifest = await command(["manifest"]);
  await save("services-manifest", manifest.output);
  assert.equal(manifest.code, 0);
  await assert.rejects(access(auditFile), (error) => error.code === "ENOENT");
  await save("services-manifest-artifact", await readFile(join(project, ".typed-sql/queries.json"), "utf8"));
  const live = await command(["verify", "--live"]);
  await save("live-verify", live.output);
  const proofFile = join(project, ".typed-sql/verification.json");
  const proofText = await readFile(proofFile, "utf8");
  await save("live-proof", proofText);
  const liveImports = await audit("live-verify");
  const proof = JSON.parse(proofText);
  assert.equal(proof.dialect, "sqlserver");
  assert.equal(proof.nativeTypeComparison, true);
  assert.equal(proof.server.version, process.env.TYPED_SQL_SQLSERVER_BUILD);
  assert.ok(
    proof.entries.some((entry) => entry.source.file.endsWith("find.sql") && entry.status === "verified"),
    "Named SQL asset needs actual native verification",
  );
  assert.ok(
    proof.entries.every((entry) => ["verified", "skipped"].includes(entry.status)),
    "Native metadata failures and mismatches remain failing counterexamples",
  );
  const skipped = proof.entries.filter((entry) => entry.status === "skipped");
  assert.ok(skipped.every((entry) => typeof entry.reason === "string" && entry.reason.length > 0));
  assert.equal(live.code, skipped.length > 0 ? 2 : 0);
  for (let replay = 1; replay <= 2; replay++) {
    // Cached verify validates manifest/proof identity only. It must not ask the
    // service for fresh server evidence or import the application-owned SDK.
    const cached = await command(["verify"]);
    await save(`cached-verify-${replay}`, cached.output);
    assert.equal(cached.code, live.code);
    assert.match(cached.output, /Cached verification is current/u);
    assert.equal(await readFile(proofFile, "utf8"), proofText);
    await assert.rejects(access(auditFile), (error) => error.code === "ENOENT");
    await save(`cached-verify-${replay}-sdk-imports`, "No SDK imports\n");
  }
  const planned = await command(["explain", "--fail-on", "none"]);
  await save("native-plans", planned.output);
  const planText = await readFile(join(project, ".typed-sql/plans.json"), "utf8");
  await save("native-plan-artifact", planText);
  await save("native-plan-review", await readFile(join(project, ".typed-sql/plan-review.json"), "utf8"));
  const planImports = await audit("native-plans");
  const plans = JSON.parse(planText);
  assert.equal(plans.dialect, "sqlserver");
  assert.equal(plans.parameterMode, "value-free");
  assert.equal(plans.environment.version, process.env.TYPED_SQL_SQLSERVER_BUILD);
  assert.equal(planned.code, 0);
  assert.ok(
    plans.entries.some(
      (entry) =>
        entry.source.file.endsWith("find.sql") && entry.status === "captured" && entry.evidence.nodes.length > 0,
    ),
    "Named SQL asset needs native structured SHOWPLAN evidence",
  );
  assert.ok(
    plans.entries.every((entry) => ["captured", "skipped"].includes(entry.status)),
    "Plan capture failures remain failing counterexamples",
  );
  assert.ok(
    plans.entries.every((entry) => entry.sampleFingerprint === undefined),
    "Value-free SQL Server planning receives no application samples",
  );
  const planSkips = plans.entries.filter((entry) => entry.status === "skipped");
  assert.ok(planSkips.every((entry) => typeof entry.reason === "string" && entry.reason.length > 0));
  await save(
    "native-services-summary",
    JSON.stringify(
      {
        liveImports,
        planImports,
        cachedReplays: 2,
        cachedSDKImports: 0,
        verificationSkips: skipped.map(({ source, reason }) => ({ source, reason })),
        planSkips: planSkips.map(({ source, reason }) => ({ source, reason })),
      },
      null,
      2,
    ),
  );
}
/** Full first-use replay imports every product API from independently installed tarballs. */
export async function firstUse(fixture) {
  const project = join(fixture.directory, "first-use");
  const database = `typed_sql_first_use_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const environment = { TYPED_SQL_FIRST_USE_DATABASE: database };
  const prefix = `first-use-${process.env.TYPED_SQL_SQLSERVER_MAJOR}`;
  const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
  const redact = (value) => (password ? String(value).replaceAll(password, "[redacted]") : String(value));
  const save = (name, text) => writeFile(join(artifacts, `${prefix}-${name}.log`), redact(text));
  await mkdir(artifacts, { recursive: true });
  await prepare(project);
  let cleanupFailure;
  try {
    const setup = await fixture.command(project, process.execPath, ["setup.mjs", "create"], { env: environment });
    await save("setup", setup.output);
    const generated = await fixture.command(
      project,
      "pnpm",
      ["exec", "typed-sql", "generate", "--config", "online.config.mjs"],
      { env: environment },
    );
    await save("online-generate", generated.output);
    const providerImports = await readFile(join(project, "native-imports.log"), "utf8");
    await save("provider-sdk-imports", providerImports);
    assert.equal(providerImports, "SDK initialized\n");
    const schema = await readFile(join(project, "generated/db/schema.json"), "utf8");
    const snapshot = JSON.parse(schema);
    assert.equal(snapshot.formatVersion, 2);
    assert.equal(snapshot.server.settings.arithAbort, true);
    assert.equal(snapshot.server.version, process.env.TYPED_SQL_SQLSERVER_BUILD);
    for (const name of ["users", "teams", "memberships", "products", "orders", "order_items", "audit_events"])
      assert.equal(snapshot.relations[`dbo.${name}`].kind, "table");
    await rm(join(project, "native-imports.log"));
    await save("offline", await replayOffline(fixture, project, environment));
    // The independent installation has no application-owned SDK at all. It receives
    // only the native-generated snapshot, never a live database dependency.
    const noDriver = await consumer(
      ["typescript", "@types/node", "esbuild"],
      ["@typed-sql/sqlserver", "@typed-sql/cli"],
    );
    try {
      await assert.rejects(stat(join(noDriver.directory, "node_modules/koffi")), (error) => error.code === "ENOENT");
      const offline = join(noDriver.directory, "first-use");
      await prepare(offline);
      await mkdir(join(offline, "generated/db"), { recursive: true });
      await writeFile(join(offline, "generated/db/schema.json"), schema);
      await save("offline-no-sdk", await replayOffline(noDriver, offline, environment));
    } finally {
      await noDriver.close();
    }
    const executed = await fixture.command(project, process.execPath, ["execute.mjs"], { env: environment });
    await save("execute", executed.output);
    const manualImports = await readFile(join(project, "native-imports.log"), "utf8");
    await save("manual-services-sdk-imports", manualImports);
    assert.equal(manualImports, "SDK initialized\nSDK initialized\n");
    await replayNativeServices(fixture, project, environment, save);
    await rm(join(artifacts, `${prefix}-failure.log`), { force: true });
    console.log(
      "SQL Server packed first-use online/offline generation, checks, SQL declarations, esbuild and native execution passed",
    );
  } catch (error) {
    await save("failure", error);
    throw error;
  } finally {
    // Even a failed setup or replay can only drop the generated disposable name.
    try {
      const cleanup = await fixture.command(project, process.execPath, ["setup.mjs", "drop"], { env: environment });
      await save("cleanup", cleanup.output);
    } catch (error) {
      await save("cleanup-failure", error);
      cleanupFailure = error;
    }
  }
  if (cleanupFailure) throw cleanupFailure;
}
