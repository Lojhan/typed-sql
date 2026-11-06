import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, catalogChanges, createPlan, inspectMigrations, type MigrationsConfig } from "@typed-sql/migrations";
import { describe, it, skip, strict } from "poku";
import { postgres } from "../src/index.js";
import { createPgMigrationTarget, migrationCatalogKey } from "../src/migrations.js";
import { loadPgDriver } from "../src/pg.js";

const targetUrl = process.env.TYPED_SQL_MIGRATION_TEST_URL;
const scratchUrl = process.env.TYPED_SQL_MIGRATION_SCRATCH_URL;
const freshUrl = process.env.TYPED_SQL_MIGRATION_FRESH_URL;
if (targetUrl === undefined || scratchUrl === undefined || freshUrl === undefined)
  skip("Set separate disposable migration target, scratch and fresh PostgreSQL URLs for engine integration.");
const { Pool } = await loadPgDriver();
const targetPool = new Pool({ connectionString: targetUrl });
const scratchPool = new Pool({ connectionString: scratchUrl });
const freshPool = new Pool({ connectionString: freshUrl });
const suffix = randomUUID().replaceAll("-", "");
const namespace = `engine_${suffix}`;
const historyNamespace = `history_${suffix}`;
const root = await realpath(await mkdtemp(join(tmpdir(), "typed-sql-migration-engine-")));
const targetDatabase = (await targetPool.query<{ name: string }>("select current_database() as name")).rows[0]!.name;
const scratchDatabase = (await scratchPool.query<{ name: string }>("select current_database() as name")).rows[0]!.name;
if (targetDatabase === scratchDatabase) throw new Error("Live engine tests require separate target/scratch databases.");
const target = createPgMigrationTarget({
  connectionString: targetUrl!,
  namespaces: [namespace],
  historyNamespace,
  expected: { database: targetDatabase },
  classification: "test",
});
const scratch = createPgMigrationTarget({
  connectionString: scratchUrl!,
  namespaces: [namespace],
  historyNamespace,
  expected: { database: scratchDatabase },
  classification: "test",
  disposable: true,
});
const freshDatabase = (await freshPool.query<{ name: string }>("select current_database() as name")).rows[0]!.name;
const fresh = createPgMigrationTarget({
  connectionString: freshUrl!,
  namespaces: [namespace],
  historyNamespace,
  expected: { database: freshDatabase },
  classification: "test",
});
const config: MigrationsConfig = {
  directory: "migrations",
  targets: { test: target, scratch, fresh },
  replayTarget: "scratch",
};
const renderer = postgres();

async function migration(
  id: string,
  up: string,
  down: string,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const directory = join(root, "migrations", id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "migration.json"),
    JSON.stringify({ formatVersion: 1, id, transaction: "required", up: "up.sql", down: "down.sql", ...extra }),
  );
  await writeFile(join(directory, "up.sql"), up);
  await writeFile(join(directory, "down.sql"), down);
}

try {
  await targetPool.query(`create schema "${namespace}"`);
  await scratchPool.query(`create schema "${namespace}"`);
  await freshPool.query(`create schema "${namespace}"`);
  await mkdir(join(root, "migrations"));
  await describe("live migration engine workflows", async () => {
    await it("bootstraps greenfield and independently replays expected history", async () => {
      await migration(
        "001-initial",
        `create table "${namespace}".accounts(id integer primary key, name text not null)`,
        `drop table "${namespace}".accounts`,
      );
      const plan = await createPlan({ root, config, renderer, target: "test" });
      strict.deepStrictEqual(
        plan.migrations.map((entry) => entry.id),
        ["001-initial"],
      );
      const result = await applyPlan({ root, config, renderer, target: "test", plan });
      strict.deepStrictEqual(result.applied, ["001-initial"]);
      strict.strictEqual(result.history.applied[0]?.origin, "executed");
      strict.deepStrictEqual((await inspectMigrations({ root, config, renderer, target: "test" })).drift, []);
      strict.deepStrictEqual((await createPlan({ root, config, renderer, target: "test" })).migrations, []);
      strict.strictEqual(
        (
          await scratchPool.query("select count(*)::integer as count from pg_catalog.pg_tables where schemaname=$1", [
            namespace,
          ])
        ).rows[0]?.count,
        0,
      );
    });

    await it("blocks manual additive drift even after application snapshot refresh", async () => {
      await targetPool.query(`alter table "${namespace}".accounts add column status text`);
      const observed = await inspectMigrations({ root, config, renderer, target: "test" });
      strict.ok(
        observed.drift.some(
          (change) => change.object === migrationCatalogKey("column", namespace, "accounts", "status"),
        ),
      );
      await migration(
        "002-status",
        `alter table "${namespace}".accounts add column status text`,
        `alter table "${namespace}".accounts drop column status`,
        {
          reconciliation: {
            reason: "Capture reviewed manual status column",
            expectedObjects: observed.drift.map((change) => change.object),
          },
        },
      );
      await writeFile(
        join(root, "application-schema.json"),
        JSON.stringify({ refreshedFromLive: true, includesStatus: true }),
      );
      await strict.rejects(createPlan({ root, config, renderer, target: "test" }), /Schema drift blocks/);
      const status = await inspectMigrations({ root, config, renderer, target: "test" });
      strict.ok(status.drift.some((change) => change.kind === "added" && change.object.startsWith("column:")));
      strict.deepStrictEqual(status.pending, ["002-status"]);
    });

    await it("reconciles exact manual effects and preserves ordinary fresh execution", async () => {
      const plan = await createPlan({ root, config, renderer, target: "test", reconcile: true });
      const result = await applyPlan({
        root,
        config,
        renderer,
        target: "test",
        plan,
        reconcile: true,
        reason: "Reviewed manual status column",
      });
      strict.strictEqual(result.history.applied[1]?.origin, "reconciled");
      const scratchPlan = await createPlan({ root, config, renderer, target: "fresh" });
      strict.strictEqual(scratchPlan.migrations.length, 2);
      await applyPlan({ root, config, renderer, target: "fresh", plan: scratchPlan });
      const mainSession = await target.connect();
      const freshSession = await fresh.connect();
      try {
        strict.deepStrictEqual(catalogChanges(await mainSession.capture(), await freshSession.capture()), []);
      } finally {
        await mainSession.close();
        await freshSession.close();
      }
    });

    await it("reverts a contiguous suffix using declared down without rewriting content", async () => {
      const plan = await createPlan({ root, config, renderer, target: "test", direction: "down", to: "001-initial" });
      strict.deepStrictEqual(
        plan.migrations.map((entry) => entry.id),
        ["002-status"],
      );
      const result = await applyPlan({ root, config, renderer, target: "test", plan });
      strict.deepStrictEqual(
        result.history.applied.map((entry) => entry.id),
        ["001-initial"],
      );
      strict.ok(
        result.history.attempts.some((entry) => entry.migrationId === "002-status" && entry.direction === "down"),
      );
      strict.deepStrictEqual((await inspectMigrations({ root, config, renderer, target: "test" })).drift, []);
    });

    await it("rolls a failed transactional postcondition back and preserves earlier completed steps", async () => {
      await scratchPool.query(
        `drop schema "${namespace}" cascade; drop schema if exists "${historyNamespace}" cascade; create schema "${namespace}"`,
      );
      await migration(
        "003-postcondition",
        `alter table "${namespace}".accounts add column must_rollback integer`,
        `alter table "${namespace}".accounts drop column must_rollback`,
        { checks: { afterUp: [{ id: "deliberate-failure", kind: "boolean", query: "select false as ok" }] } },
      );
      const plan = await createPlan({ root, config, renderer, target: "test" });
      await strict.rejects(applyPlan({ root, config, renderer, target: "test", plan }), /deliberate-failure/);
      const session = await target.connect();
      try {
        const history = await session.history();
        strict.deepStrictEqual(
          history.applied.map((entry) => entry.id),
          ["001-initial", "002-status"],
        );
        strict.ok(
          history.attempts.some((entry) => entry.migrationId === "003-postcondition" && entry.state === "rolled-back"),
        );
        strict.strictEqual(
          (await session.capture()).objects[migrationCatalogKey("column", namespace, "accounts", "must_rollback")],
          undefined,
        );
      } finally {
        await session.close();
      }
      await rm(join(root, "migrations", "003-postcondition"), { recursive: true });
    });

    await it("blocks uncertain nontransactional partial effects instead of replaying them", async () => {
      await targetPool.query(`insert into "${namespace}".accounts(id,name) values(1,'existing live data')`);
      await migration(
        "004-partial",
        `create index concurrently partial_index on "${namespace}".accounts(name); insert into "${namespace}".accounts(id,name) values(1,'duplicate');`,
        `drop index "${namespace}".partial_index`,
        { transaction: "none" },
      );
      const plan = await createPlan({ root, config, renderer, target: "test" });
      await strict.rejects(applyPlan({ root, config, renderer, target: "test", plan }), /may have committed effects/);
      const session = await target.connect();
      try {
        strict.ok(
          (await session.history()).attempts.some(
            (entry) => entry.migrationId === "004-partial" && entry.state === "unknown",
          ),
        );
        strict.ok(
          (await session.capture()).objects[migrationCatalogKey("index", namespace, "accounts", "partial_index")],
        );
      } finally {
        await session.close();
      }
      await strict.rejects(createPlan({ root, config, renderer, target: "test" }), /unresolved attempt/);
    });
  });
} finally {
  for (const pool of [targetPool, scratchPool, freshPool]) {
    await pool.query(`drop schema if exists "${namespace}" cascade`);
    await pool.query(`drop schema if exists "${historyNamespace}" cascade`);
    await pool.end();
  }
  await rm(root, { recursive: true, force: true });
}
