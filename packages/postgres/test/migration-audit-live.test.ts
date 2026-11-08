import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, skip, strict } from "poku";
import { applyPlan, createPlan, type MigrationsConfig, runChecks } from "../../migrations/src/index.js";
import { postgres } from "../src/analysis.js";
import { createPgMigrationTarget, migrationCatalogKey } from "../src/migrations.js";
import { loadPgDriver } from "../src/pg.js";

const connectionString = process.env.TYPED_SQL_MIGRATION_TEST_URL;
const scratchUrl = process.env.TYPED_SQL_MIGRATION_SCRATCH_URL;
if (connectionString === undefined || scratchUrl === undefined)
  skip("Set separate disposable PostgreSQL URLs for independent migration audit cases.");
const { Pool } = await loadPgDriver();
const admin = new Pool({ connectionString });
const scratchAdmin = new Pool({ connectionString: scratchUrl });
const namespace = `audit_${randomUUID().replaceAll("-", "")}`;
const root = await realpath(await mkdtemp(join(tmpdir(), "typed-sql-migration-audit-")));

try {
  await admin.query(`create schema "${namespace}"`);
  await scratchAdmin.query(`create schema "${namespace}"`);
  const database = (await admin.query<{ name: string }>("select current_database() as name")).rows[0]!.name;
  const make = (disposable: boolean) =>
    createPgMigrationTarget({
      connectionString: connectionString!,
      namespaces: [namespace],
      historyNamespace: `${namespace}_ledger`,
      classification: "test",
      expected: { database },
      disposable,
    });
  const config: MigrationsConfig = {
    directory: "migrations",
    targets: { application: make(false), scratchAlias: make(true) },
    replayTarget: "scratchAlias",
  };
  const migration = join(root, "migrations", "001_initial");
  await mkdir(migration, { recursive: true });
  await writeFile(
    join(migration, "migration.json"),
    JSON.stringify({
      formatVersion: 1,
      id: "001_initial",
      transaction: "none",
      up: "up.sql",
      irreversibleReason: "Audit fixture is removed separately",
    }),
  );
  await writeFile(join(migration, "up.sql"), `create table "${namespace}".must_not_exist(id integer)`);

  await describe("independent migration safety audit", async () => {
    await it("rejects a disposable alias of the application database before any replay SQL", async () => {
      await strict.rejects(
        () => createPlan({ root, config, renderer: postgres(), target: "application" }),
        /(?:separate|distinct|different)/iu,
      );
      const observed = await admin.query<{ relation: string | null }>("select to_regclass($1) as relation", [
        `${namespace}.must_not_exist`,
      ]);
      strict.equal(
        observed.rows[0]!.relation,
        null,
        "A read-only migration plan must never create its application target table",
      );
    });

    await it("does not certify ADD COLUMN default backfills from matching schema alone", async () => {
      const scratchDatabase = (await scratchAdmin.query<{ name: string }>("select current_database() as name")).rows[0]!
        .name;
      strict.notEqual(database, scratchDatabase);
      const independent: MigrationsConfig = {
        directory: "migrations",
        targets: {
          application: make(false),
          scratch: createPgMigrationTarget({
            connectionString: scratchUrl!,
            namespaces: [namespace],
            historyNamespace: `${namespace}_ledger`,
            classification: "test",
            expected: { database: scratchDatabase },
            disposable: true,
          }),
        },
        replayTarget: "scratch",
      };
      await writeFile(
        join(migration, "migration.json"),
        JSON.stringify({
          formatVersion: 1,
          id: "001_initial",
          transaction: "required",
          up: "up.sql",
          down: "down.sql",
        }),
      );
      await writeFile(
        join(migration, "up.sql"),
        `create table "${namespace}".accounts(id integer primary key); insert into "${namespace}".accounts values(1);`,
      );
      await writeFile(join(migration, "down.sql"), `drop table "${namespace}".accounts`);
      const initial = await createPlan({ root, config: independent, renderer: postgres(), target: "application" });
      await applyPlan({ root, config: independent, renderer: postgres(), target: "application", plan: initial });

      // The same final column definition, but a different effect on preexisting rows.
      await admin.query(
        `alter table "${namespace}".accounts add column status text; alter table "${namespace}".accounts alter column status set default 'active';`,
      );
      const second = join(root, "migrations", "002_status");
      await mkdir(second);
      await writeFile(
        join(second, "migration.json"),
        JSON.stringify({
          formatVersion: 1,
          id: "002_status",
          transaction: "required",
          up: "up.sql",
          reconciliation: {
            reason: "Audit matching schema with missing historical backfill",
            expectedObjects: [migrationCatalogKey("column", namespace, "accounts", "status")],
          },
        }),
      );
      await writeFile(
        join(second, "up.sql"),
        `alter table "${namespace}".accounts add column status text default 'active'`,
      );
      const plan = await createPlan({
        root,
        config: independent,
        renderer: postgres(),
        target: "application",
        reconcile: true,
        to: "002_status",
      });
      strict.equal(
        (await admin.query<{ status: string | null }>(`select status from "${namespace}".accounts where id=1`)).rows[0]!
          .status,
        null,
        "The manual two-step change did not backfill preexisting rows",
      );
      await scratchAdmin.query("begin");
      try {
        await scratchAdmin.query(
          `create table "${namespace}".accounts(id integer primary key); insert into "${namespace}".accounts values(1); alter table "${namespace}".accounts add column status text default 'active';`,
        );
        strict.equal(
          (await scratchAdmin.query<{ status: string }>(`select status from "${namespace}".accounts where id=1`))
            .rows[0]!.status,
          "active",
          "The proposed up operation would populate those same preexisting rows",
        );
      } finally {
        await scratchAdmin.query("rollback");
      }
      await strict.rejects(
        () =>
          applyPlan({
            root,
            config: independent,
            renderer: postgres(),
            target: "application",
            reconcile: true,
            reason: "Review missing data effect",
            plan,
          }),
        /(?:default|proof|schema-only)/iu,
      );
      strict.equal(
        (await admin.query<{ status: string | null }>(`select status from "${namespace}".accounts where id=1`)).rows[0]!
          .status,
        null,
      );
    });

    await it("preserves a usable migration transaction after an advisory query error", async () => {
      const session = await make(false).connect();
      try {
        await session.lock(2000);
        await session.begin();
        const findings = await runChecks(
          session,
          {
            beforeUp: [
              {
                id: "optional-legacy-check",
                kind: "boolean",
                severity: "warning",
                query: { text: "select enabled from no_such_optional_legacy_table", values: [] },
              },
            ],
          },
          {},
          "beforeUp",
        );
        strict.equal(findings[0]?.status, "unknown");
        strict.equal(findings[0]?.severity, "warning");
        await session.execute({ text: `create table "${namespace}".advisory_survived(id integer)`, values: [] });
        strict.ok(
          Object.hasOwn(
            (await session.capture()).objects,
            migrationCatalogKey("relation", namespace, "advisory_survived"),
          ),
        );
        await session.rollback();
      } finally {
        await session.close();
      }
      strict.equal(
        (
          await admin.query<{ relation: string | null }>("select to_regclass($1) as relation", [
            `${namespace}.advisory_survived`,
          ])
        ).rows[0]!.relation,
        null,
      );
    });
  });
} finally {
  await admin.query(`drop schema if exists "${namespace}" cascade`);
  await admin.query(`drop schema if exists "${namespace}_ledger" cascade`);
  await scratchAdmin.query(`drop schema if exists "${namespace}" cascade`);
  await scratchAdmin.query(`drop schema if exists "${namespace}_ledger" cascade`);
  await scratchAdmin.end();
  await admin.end();
  await rm(root, { recursive: true, force: true });
}
