import { randomUUID } from "node:crypto";
import { emptyHistory } from "@typed-sql/migrations";
import { describe, it, skip, strict } from "poku";
import { createPgMigrationTarget, migrationCatalogKey } from "../src/migrations.js";
import { loadPgDriver } from "../src/pg.js";

const connectionString = process.env.TYPED_SQL_MIGRATION_TEST_URL;
if (connectionString === undefined)
  skip("Set TYPED_SQL_MIGRATION_TEST_URL to an explicitly disposable PostgreSQL database.");
const { Pool } = await loadPgDriver();
const admin = new Pool({ connectionString });
const suffix = randomUUID().replaceAll("-", "");
const schema = `migration_review_${suffix}`;
const historyNamespace = `migration_ledger_${suffix}`;
const database = (await admin.query<{ database: string }>("select current_database() as database")).rows[0]!.database;
const target = createPgMigrationTarget({
  connectionString: connectionString!,
  namespaces: [schema],
  historyNamespace,
  classification: "test",
  expected: { database },
});

try {
  await admin.query(`create schema "${schema}"`);
  await describe("live PostgreSQL migration session", async () => {
    await it("captures uncommitted DDL and rolls SQL and history back together", async () => {
      const session = await target.connect();
      try {
        strict.strictEqual((await session.identity()).database, database);
        strict.deepStrictEqual(await session.history(), emptyHistory());
        const before = await session.capture();
        strict.strictEqual(before.coverage, "complete");
        strict.strictEqual(Object.keys(before.objects).length, 1);
        await session.lock(1000);
        await session.bootstrap();
        await session.begin();
        await session.execute({
          text: `create table "${schema}".accounts(id bigint generated always as identity primary key, name text not null default 'new', check(length(name)>0)); create index accounts_name on "${schema}".accounts(name);`,
          values: [],
        });
        const during = await session.capture();
        strict.ok(during.objects[migrationCatalogKey("relation", schema, "accounts")]);
        strict.ok(during.objects[migrationCatalogKey("column", schema, "accounts", "name")]);
        strict.ok(during.objects[migrationCatalogKey("index", schema, "accounts", "accounts_name")]);
        strict.ok(Object.keys(during.objects).some((key) => key.startsWith("sequence:")));
        const attempted = {
          ...emptyHistory(),
          attempts: [
            {
              id: "attempt-a",
              migrationId: "migration-a",
              hash: "a".repeat(64),
              direction: "up" as const,
              state: "running" as const,
            },
          ],
        };
        await session.saveHistory(attempted);
        strict.strictEqual((await session.history()).attempts.length, 1);
        await session.rollback();
        strict.deepStrictEqual(await session.capture(), before);
        strict.deepStrictEqual(await session.history(), emptyHistory());
      } finally {
        await session.close();
      }
    });

    await it("serializes competing sessions and commits catalog/history atomically", async () => {
      const first = await target.connect();
      const second = await target.connect();
      try {
        await first.lock(1000);
        await strict.rejects(second.lock(30), /Another migration runner/);
        await first.begin();
        await first
          .execute({
            text: `create table "${schema}".accounts(id integer primary key, name text not null); insert into "${schema}".accounts values($1,$2)`,
            values: [1, "Alice"],
          })
          .then(
            () => {
              throw new Error("multi-statement bindings must be rejected");
            },
            (error: unknown) => {
              strict.match(String(error), /exactly one statement/);
            },
          );
        await first.execute({
          text: `create table "${schema}".accounts(id integer primary key, name text not null)`,
          values: [],
        });
        await first.execute({ text: `insert into "${schema}".accounts values($1,$2)`, values: [1, "Alice"] });
        await first.saveHistory(emptyHistory());
        await first.commit();
        strict.ok((await second.capture()).objects[migrationCatalogKey("relation", schema, "accounts")]);
        await first.unlock();
        await second.lock(1000);
        await second.unlock();
      } finally {
        await first.close();
        await second.close();
      }
    });

    await it("detects additive/manual definition changes without retaining SQL defaults", async () => {
      const session = await target.connect();
      try {
        const before = await session.capture();
        await admin.query(`alter table "${schema}".accounts add column status text default 'PRIVATE_DEFAULT_VALUE'`);
        await admin.query(`create unique index manual_name_unique on "${schema}".accounts(name)`);
        const after = await session.capture();
        strict.notDeepStrictEqual(after, before);
        strict.ok(after.objects[migrationCatalogKey("column", schema, "accounts", "status")]);
        strict.ok(after.objects[migrationCatalogKey("index", schema, "accounts", "manual_name_unique")]);
        strict.ok(!JSON.stringify(after).includes("PRIVATE_DEFAULT_VALUE"));
        await admin.query(`alter table "${schema}".accounts alter column status set default 'changed'`);
        strict.notDeepStrictEqual(
          (await session.capture()).objects[migrationCatalogKey("column", schema, "accounts", "status")],
          after.objects[migrationCatalogKey("column", schema, "accounts", "status")],
        );
      } finally {
        await session.close();
      }
    });

    await it("uses bounded native assertion results with strict boolean decoding", async () => {
      const session = await target.connect();
      try {
        strict.strictEqual(
          await session.check({ text: "select generate_series(1,100000000)", values: [] }, "noRows"),
          false,
        );
        strict.strictEqual(await session.check({ text: "select 1 where false;", values: [] }, "noRows"), true);
        strict.strictEqual(
          await session.check({ text: "select 1 where false -- trailing comment", values: [] }, "noRows"),
          true,
        );
        strict.strictEqual(await session.check({ text: "select $1::boolean as ok;", values: [true] }, "boolean"), true);
        strict.strictEqual(await session.check({ text: "select false as ok", values: [] }, "boolean"), false);
        for (const text of [
          "select null as ok",
          "select 1 as ok",
          "select true as ok, true as another",
          "select true union all select false",
          "select true where false",
        ])
          await strict.rejects(session.check({ text, values: [] }, "boolean"), /exactly one non-null boolean/);
        await strict.rejects(session.check({ text: "delete from accounts", values: [] }, "noRows"), /one SELECT/);
      } finally {
        await session.close();
      }
    });

    await it("executes dollar bodies and concurrent indexes with declared transaction boundaries", async () => {
      const session = await target.connect();
      try {
        await session.lock(1000);
        await session.execute({
          text: `create function "${schema}".greeting() returns text language plpgsql as $$begin return 'hello; world'; end;$$; create index concurrently accounts_status on "${schema}".accounts(status);`,
          values: [],
        });
        const evidence = await session.capture();
        strict.ok(evidence.objects[migrationCatalogKey("routine", schema, "greeting", "")]);
        strict.ok(evidence.objects[migrationCatalogKey("index", schema, "accounts", "accounts_status")]);
        strict.ok(!JSON.stringify(evidence).includes("hello; world"));
      } finally {
        await session.close();
      }
    });

    await it("marks inaccessible namespace evidence unknown and sanitizes SQL errors", async () => {
      const absent = createPgMigrationTarget({
        connectionString: connectionString!,
        namespaces: [`missing_${suffix}`],
        classification: "test",
        expected: { database },
      });
      const missing = await absent.connect();
      const session = await target.connect();
      try {
        strict.strictEqual((await missing.capture()).coverage, "unknown");
        await strict.rejects(session.execute({ text: "select 1", values: [] }), /Acquire the target migration lock/);
        await session.lock(1000);
        await session.begin();
        await strict.rejects(
          session.execute({ text: "select PRIVATE_SQL_THAT_MUST_NOT_BE_IN_ERROR", values: [] }),
          (error: unknown) => {
            strict.ok(!String(error).includes("PRIVATE_SQL"));
            strict.match(String(error), /SQLSTATE 42703/);
            return true;
          },
        );
        await session.rollback();
        await session.close();
        await session.close();
        await strict.rejects(session.identity(), /closed/);
      } finally {
        await missing.close();
        await session.close();
      }
    });

    await it("detects an indirectly released server lock before further ledger writes", async () => {
      const session = await target.connect();
      try {
        await session.lock(1000);
        await session.execute({
          text: `create function "${schema}".release_runner_lock() returns void language sql as $$select pg_catalog.pg_advisory_unlock_all()$$`,
          values: [],
        });
        await strict.rejects(
          session.execute({ text: `select "${schema}".release_runner_lock()`, values: [] }),
          /no longer confirms ownership/,
        );
        await strict.rejects(session.saveHistory(emptyHistory()), /Acquire the target migration lock/);
      } finally {
        await session.close();
      }
    });
  });
} finally {
  await admin.query(`drop schema if exists "${schema}" cascade`);
  await admin.query(`drop schema if exists "${historyNamespace}" cascade`);
  await admin.end();
}
