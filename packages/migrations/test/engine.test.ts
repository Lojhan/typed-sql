import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  applyPlan,
  type CatalogEvidence,
  captureMigration,
  checks,
  createPlan,
  defineMigration,
  digest,
  emptyHistory,
  inspectMigrations,
  MigrationError,
  type MigrationHistory,
  type MigrationSession,
  type MigrationsConfig,
  type MigrationTarget,
  parseHistory,
  parsePlan,
} from "../src/index.js";

const renderer = { placeholder: (i: number) => `$${i}`, quoteIdentifier: (s: string) => `"${s}"` };
const initial: CatalogEvidence = {
  formatVersion: 1,
  dialect: "test",
  serverMajor: "1",
  namespaces: ["public"],
  objects: {},
  coverage: "complete",
};
function memoryTarget(database: string): {
  target: MigrationTarget;
  state: { catalog: CatalogEvidence; history: MigrationHistory; executed: string[]; fail: string | undefined };
} {
  const state = {
    catalog: structuredClone(initial),
    history: emptyHistory(),
    executed: [] as string[],
    fail: undefined as string | undefined,
  };
  const target: MigrationTarget = {
    classification: "test",
    expected: { database },
    disposable: true,
    async connect() {
      let snapshot: typeof state | undefined;
      const session: MigrationSession = {
        async identity() {
          return { database, server: "test", dialect: "test" };
        },
        async capture() {
          return structuredClone(state.catalog);
        },
        async history() {
          return structuredClone(state.history);
        },
        async lock() {},
        async unlock() {},
        async bootstrap() {},
        async close() {},
        async begin() {
          snapshot = structuredClone(state);
        },
        async commit() {
          snapshot = undefined;
        },
        async rollback() {
          if (snapshot) {
            state.catalog = snapshot.catalog;
            state.history = snapshot.history;
            snapshot = undefined;
          }
        },
        async execute(statement) {
          state.executed.push(statement.text);
          if (statement.text === state.fail) throw new Error("secret driver SQL text");
          const [action, key] = statement.text.split(" ");
          const objects = { ...state.catalog.objects };
          if (action === "create") objects[key!] = { definition: key! };
          else if (action === "drop") delete objects[key!];
          else throw new Error("unsupported statement");
          state.catalog = { ...state.catalog, objects };
          return [];
        },
        async check(statement) {
          return statement.text === "pass";
        },
        validate() {},
        validateReconciliation() {},
        async saveHistory(history) {
          state.history = structuredClone(history);
        },
      };
      return session;
    },
  };
  return { target, state };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "typed-sql-migrations-"));
  await mkdir(join(root, "migrations"));
  const local = memoryTarget("local"),
    scratch = memoryTarget("scratch");
  const config: MigrationsConfig = {
    directory: "migrations",
    targets: { local: local.target, scratch: scratch.target },
    replayTarget: "scratch",
  };
  async function add(id: string, up: string, down?: string, extra: Record<string, unknown> = {}) {
    const path = join(root, "migrations", id);
    await mkdir(path);
    await writeFile(
      join(path, "migration.json"),
      JSON.stringify({
        formatVersion: 1,
        id,
        up: "up.sql",
        ...(down === undefined ? {} : { down: "down.sql" }),
        ...extra,
      }),
    );
    await writeFile(join(path, "up.sql"), up);
    if (down !== undefined) await writeFile(join(path, "down.sql"), down);
  }
  const options = { root, config, renderer, target: "local" };
  return {
    root,
    local,
    scratch,
    config,
    add,
    options,
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
await describe("migration plans, history and drift", async () => {
  await it("replays independently, applies once, reverts and reapplies immutable migrations", async () => {
    const f = await fixture();
    try {
      await f.add("001_accounts", "create accounts", "drop accounts");
      await f.add("002_status", "create status", "drop status");
      const plan = await createPlan(f.options);
      strict.equal(plan.migrations.length, 2);
      strict.deepEqual(f.scratch.state.catalog, initial);
      strict.equal(parsePlan(JSON.parse(JSON.stringify(plan))).hash, plan.hash);
      strict.deepEqual((await applyPlan({ ...f.options, plan })).applied, ["001_accounts", "002_status"]);
      strict.equal(f.local.state.history.applied.length, 2);
      strict.equal((await createPlan(f.options)).migrations.length, 0);
      const down = await createPlan({ ...f.options, direction: "down", to: "001_accounts" });
      await applyPlan({ ...f.options, plan: down });
      strict.equal(f.local.state.history.applied.length, 1);
      await applyPlan({ ...f.options, plan: await createPlan(f.options) });
      strict.equal(f.local.state.history.applied.length, 2);
      strict.equal(parseHistory(JSON.parse(JSON.stringify(f.local.state.history))).applied.length, 2);
    } finally {
      await f.close();
    }
  });
  await it("blocks additive manual drift even if an application snapshot is refreshed", async () => {
    const f = await fixture();
    try {
      await f.add("001_accounts", "create accounts");
      await applyPlan({ ...f.options, plan: await createPlan(f.options) });
      f.local.state.catalog = {
        ...f.local.state.catalog,
        objects: { ...f.local.state.catalog.objects, manual_index: { definition: "manual" } },
      };
      await writeFile(join(f.root, "application-snapshot.json"), JSON.stringify(f.local.state.catalog));
      await f.add("002_other", "create other");
      const status = await inspectMigrations(f.options);
      strict.equal(status.drift[0]?.object, "manual_index");
      await strict.rejects(
        createPlan(f.options),
        (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_DRIFT",
      );
    } finally {
      await f.close();
    }
  });
  await it("adopts exact manual DDL but blocks partial/unrelated effects and replays on a fresh target", async () => {
    const f = await fixture();
    try {
      await f.add("001_accounts", "create accounts");
      await applyPlan({ ...f.options, plan: await createPlan(f.options) });
      await f.add("002_status", "create status", undefined, {
        reconciliation: { reason: "Manual status", expectedObjects: ["status"] },
      });
      f.local.state.catalog = {
        ...f.local.state.catalog,
        objects: { ...f.local.state.catalog.objects, status: { definition: "status" } },
      };
      const plan = await createPlan({ ...f.options, reconcile: true });
      const executed = f.local.state.executed.length;
      await applyPlan({ ...f.options, plan, reconcile: true, reason: "Reviewed manual schema change" });
      strict.equal(f.local.state.executed.length, executed);
      strict.equal(f.local.state.history.applied.at(-1)?.origin, "reconciled");
      const fresh = memoryTarget("fresh");
      const config = { ...f.config, targets: { ...f.config.targets, fresh: fresh.target } };
      await applyPlan({
        ...f.options,
        config,
        target: "fresh",
        plan: await createPlan({ ...f.options, config, target: "fresh" }),
      });
      strict.equal(digest(fresh.state.catalog), digest(f.local.state.catalog));
    } finally {
      await f.close();
    }
  });
  await it("rolls SQL and applied history back on failure and never logs the driver error", async () => {
    const f = await fixture();
    try {
      await f.add("001_accounts", "create accounts");
      const plan = await createPlan(f.options);
      f.local.state.fail = "create accounts";
      await strict.rejects(
        applyPlan({ ...f.options, plan }),
        (error: unknown) =>
          error instanceof MigrationError && error.code === "MIGRATION_SQL_FAILED" && !error.message.includes("secret"),
      );
      strict.equal(f.local.state.history.applied.length, 0);
      strict.deepEqual(f.local.state.catalog, initial);
      strict.equal(f.local.state.history.attempts.at(-1)?.state, "rolled-back");
    } finally {
      await f.close();
    }
  });
  await it("blocks source changes, stale plans and changed applied files", async () => {
    const f = await fixture();
    try {
      await f.add("001_accounts", "create accounts");
      const plan = await createPlan(f.options);
      await writeFile(join(f.root, "migrations", "001_accounts", "up.sql"), "create different");
      await strict.rejects(applyPlan({ ...f.options, plan }), /captured migration input changed/);
      const changed = await createPlan(f.options);
      f.local.state.catalog = { ...initial, objects: { unexpected: {} } };
      await strict.rejects(applyPlan({ ...f.options, plan: changed }), /changed since/);
    } finally {
      await f.close();
    }
  });
  await it("composes blocking project/local checks and rolls back failed postconditions", async () => {
    const f = await fixture();
    try {
      await f.add("001_accounts", "create accounts", undefined, {
        checks: { afterUp: [checks.noRows({ id: "bad-data", query: "fail" })] },
      });
      const plan = await createPlan(f.options);
      await strict.rejects(applyPlan({ ...f.options, plan }), /bad-data/);
      strict.deepEqual(f.local.state.catalog, initial);
    } finally {
      await f.close();
    }
  });
  await it("rejects corrupted persisted attempts and tampered plans", async () => {
    strict.throws(() => parseHistory({ formatVersion: 1, applied: [], attempts: [{ id: "bad" }] }), /Invalid/);
    const migration = captureMigration(defineMigration({ id: "001", up: ["create accounts"] }), {}, renderer);
    strict.equal(migration.up[0]?.text, "create accounts");
    const f = await fixture();
    try {
      await f.add("001", "create accounts");
      const plan = await createPlan(f.options);
      strict.throws(() => parsePlan({ ...plan, catalogHash: "changed" }), /Invalid or modified/);
    } finally {
      await f.close();
    }
  });
});
