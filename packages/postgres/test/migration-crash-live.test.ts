import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, skip, strict } from "poku";
import {
  applyPlan,
  createPlan,
  inspectMigrations,
  type MigrationsConfig,
  resolveAttempt,
} from "../../migrations/src/index.js";
import { postgres } from "../src/index.js";
import { createPgMigrationTarget } from "../src/migrations.js";
import { loadPgDriver } from "../src/pg.js";

const targetUrl = process.env.TYPED_SQL_MIGRATION_TEST_URL;
const scratchUrl = process.env.TYPED_SQL_MIGRATION_SCRATCH_URL;
if (targetUrl === undefined || scratchUrl === undefined)
  skip("Set separate disposable PostgreSQL URLs for actual process-crash verification.");

const { Pool } = await loadPgDriver();
const application = new Pool({ connectionString: targetUrl });
const scratch = new Pool({ connectionString: scratchUrl });
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const suffix = randomUUID().replaceAll("-", "");
const root = await realpath(await mkdtemp(join(tmpdir(), "typed-sql-crash-audit-")));
const database = (await application.query<{ name: string }>("select current_database() as name")).rows[0]!.name;
const scratchDatabase = (await scratch.query<{ name: string }>("select current_database() as name")).rows[0]!.name;
strict.notEqual(database, scratchDatabase);
const schemas: string[] = [];
const children: ChildProcess[] = [];

async function waitFor(test: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function crashCase(transaction: "required" | "none"): Promise<void> {
  const namespace = `crash_${transaction}_${suffix}`;
  const ledger = `${namespace}_ledger`;
  const appName = `typed_sql_crash_${transaction}_${suffix}`;
  schemas.push(namespace, ledger);
  await application.query(`create schema "${namespace}"`);
  await scratch.query(`create schema "${namespace}"`);
  const caseRoot = join(root, transaction);
  const migration = join(caseRoot, "migrations", "001_crash");
  await mkdir(migration, { recursive: true });
  await writeFile(
    join(migration, "migration.json"),
    JSON.stringify({
      formatVersion: 1,
      id: "001_crash",
      transaction,
      up: "up.sql",
      down: "down.sql",
    }),
  );
  await writeFile(
    join(migration, "up.sql"),
    `
create table "${namespace}".effects(id integer primary key);
select case when current_setting('application_name') = '${appName}' then pg_sleep(5) else null end;
`,
  );
  await writeFile(join(migration, "down.sql"), `drop table "${namespace}".effects`);
  const target = createPgMigrationTarget({
    connectionString: targetUrl!,
    namespaces: [namespace],
    historyNamespace: ledger,
    classification: "test",
    expected: { database },
  });
  const config: MigrationsConfig = {
    directory: "migrations",
    targets: {
      application: target,
      scratch: createPgMigrationTarget({
        connectionString: scratchUrl!,
        namespaces: [namespace],
        historyNamespace: ledger,
        classification: "test",
        expected: { database: scratchDatabase },
        disposable: true,
      }),
    },
    replayTarget: "scratch",
  };
  const plan = await createPlan({ root: caseRoot, config, target: "application", renderer: postgres() });
  const planFile = join(caseRoot, "plan.json");
  await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
  const childUrl = new URL(targetUrl!);
  childUrl.searchParams.set("application_name", appName);
  const moduleUrl = (packageName: string, entry: string) =>
    pathToFileURL(join(workspace, "packages", packageName, "dist", "packages", packageName, "src", entry)).href;
  const childFile = join(caseRoot, "child.mjs");
  await writeFile(
    childFile,
    `
import {readFile} from 'node:fs/promises';
import {applyPlan} from ${JSON.stringify(moduleUrl("migrations", "index.js"))};
import {postgres} from ${JSON.stringify(moduleUrl("postgres", "index.js"))};
import {createPgMigrationTarget} from ${JSON.stringify(moduleUrl("postgres", "migrations.js"))};
const target=createPgMigrationTarget(${JSON.stringify({ connectionString: childUrl.href, namespaces: [namespace], historyNamespace: ledger, classification: "test", expected: { database } })});
await applyPlan({root:${JSON.stringify(caseRoot)},config:{directory:'migrations',targets:{application:target}},target:'application',renderer:postgres(),plan:JSON.parse(await readFile(${JSON.stringify(planFile)},'utf8'))});
`,
  );
  const child = spawn(process.execPath, [childFile], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let errorOutput = "";
  child.stderr!.on("data", (chunk) => {
    errorOutput += String(chunk);
  });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Crash worker exited before its pause: ${errorOutput}`);
    return (
      await application.query<{ active: boolean }>(
        "select exists(select 1 from pg_stat_activity where application_name=$1 and state='active' and query like '%pg_sleep(5)%') as active",
        [appName],
      )
    ).rows[0]!.active;
  }, "the migration's database pause");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  const [, signal] = await exited;
  strict.equal(signal, "SIGKILL");
  await waitFor(
    async () =>
      !(
        await application.query<{ active: boolean }>(
          "select exists(select 1 from pg_stat_activity where application_name=$1) as active",
          [appName],
        )
      ).rows[0]!.active,
    "the disconnected backend to finish and release its transaction/lock",
  );

  const status = await inspectMigrations({ root: caseRoot, config, target: "application", renderer: postgres() });
  strict.ok(status.diagnostics.some((diagnostic) => diagnostic.code === "MIGRATION_OUTCOME_UNKNOWN"));
  strict.equal(status.history.applied.length, 0);
  strict.equal(status.history.attempts[0]?.state, "running");
  const table = (
    await application.query<{ present: string | null }>("select to_regclass($1) as present", [`${namespace}.effects`])
  ).rows[0]!.present;
  strict.equal(table !== null, transaction === "none", "Only nontransactional effects survive a killed runner");
  await strict.rejects(
    () => createPlan({ root: caseRoot, config, target: "application", renderer: postgres() }),
    /unresolved attempt/,
  );

  if (transaction === "none") {
    strict.equal(status.driftState, "drifted");
    await strict.rejects(
      () =>
        resolveAttempt({
          config,
          target: "application",
          evidence: { ...status.resolutionEvidence[0], effectsVerified: true },
          action: "confirm-not-applied",
          reason: "Cannot attest to absent effects while table remains",
        }),
      /does not match/,
    );
    // Explicit remediation is independent of metadata resolution; never automatically run down.
    await application.query(`drop table "${namespace}".effects`);
  }
  const inspected = await inspectMigrations({ root: caseRoot, config, target: "application", renderer: postgres() });
  await resolveAttempt({
    config,
    target: "application",
    evidence: { ...inspected.resolutionEvidence[0], effectsVerified: true },
    action: "confirm-not-applied",
    reason: "Inspected absent effects after process crash",
  });
  const resolved = await inspectMigrations({ root: caseRoot, config, target: "application", renderer: postgres() });
  strict.equal(resolved.history.attempts[0]?.resolution, "confirm-not-applied");
  strict.ok(!resolved.diagnostics.some((diagnostic) => diagnostic.code === "MIGRATION_OUTCOME_UNKNOWN"));
  if (transaction === "required") {
    const retry = await createPlan({ root: caseRoot, config, target: "application", renderer: postgres() });
    strict.deepEqual(
      (await applyPlan({ root: caseRoot, config, target: "application", renderer: postgres(), plan: retry })).applied,
      ["001_crash"],
    );
  }
}

try {
  await describe("actual migration runner crashes", async () => {
    await it("retains blocked history while a killed transactional migration rolls back", () => crashCase("required"));
    await it("retains partial nontransactional effects and refuses a false no-effects resolution", () =>
      crashCase("none"));
  });
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  // Only this test's uniquely named backends and schemas are touched during cleanup.
  await application.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where application_name = any($1::text[])",
    [[`typed_sql_crash_required_${suffix}`, `typed_sql_crash_none_${suffix}`]],
  );
  for (const namespace of schemas.reverse()) {
    await application.query(`drop schema if exists "${namespace}" cascade`);
    await scratch.query(`drop schema if exists "${namespace}" cascade`);
  }
  await application.end();
  await scratch.end();
  await rm(root, { recursive: true, force: true });
}
