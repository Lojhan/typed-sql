import { EventEmitter } from "node:events";
import { emptyHistory } from "@typed-sql/migrations";
import { describe, it, strict } from "poku";
import { createPgMigrationTarget, migrationCatalogKey, type PgMigrationTargetOptions } from "../src/migrations.js";

interface Response {
  readonly rows: readonly Record<string, unknown>[];
  readonly fields: readonly { readonly name: string }[];
}
class FakeClient extends EventEmitter {
  readonly queries: string[] = [];
  released: boolean | Error | undefined;
  held = true;
  available = true;
  ledger = false;
  history: unknown = emptyHistory();
  failure: RegExp | undefined;
  version = "180000";
  scope: readonly Record<string, unknown>[] = [{ name: "public", usable: true }];
  catalog: readonly Record<string, unknown>[] = [
    { kind: "namespace", names: ["public"], definition: { name: "public" } },
  ];
  saved = true;
  async query(text: string, values: readonly unknown[] = []): Promise<Response> {
    this.queries.push(text);
    if (this.failure?.test(text)) throw Object.assign(new Error("PRIVATE driver detail"), { code: "XX000" });
    let rows: readonly Record<string, unknown>[] = [];
    if (text.includes("as database,")) rows = [{ database: "test", address: "127.0.0.1", port: 5432 }];
    else if (text.includes("server_version_num")) rows = [{ version: this.version }];
    else if (text.includes("as name, pg_catalog.has_schema_privilege")) rows = this.scope;
    else if (text.includes("with namespaces as")) rows = this.catalog;
    else if (text.includes("to_regclass")) rows = [{ present: this.ledger ? "typed_sql.migration_history" : null }];
    else if (text.startsWith("select document")) rows = this.history === undefined ? [] : [{ document: this.history }];
    else if (text.includes("pg_try_advisory_lock")) rows = [{ acquired: this.available }];
    else if (text.includes("pg_advisory_unlock")) rows = [{ released: this.held }];
    else if (text.includes("as held")) rows = [{ held: this.held }];
    else if (text.startsWith("create table")) this.ledger = true;
    else if (text.startsWith("update")) {
      this.history = JSON.parse(String(values[0]));
      rows = this.saved ? [{ singleton: true }] : [];
    } else if (text.startsWith("select not exists")) rows = [{ ok: true }];
    else if (text.startsWith("select * from (")) rows = [{ ok: true }];
    return { rows, fields: Object.keys(rows[0] ?? {}).map((name) => ({ name })) };
  }
  release(value?: Error | boolean): void {
    this.released = value;
  }
}

function fixture(overrides: Partial<PgMigrationTargetOptions> = {}) {
  const client = new FakeClient();
  const state = { ended: false, failConnect: false };
  class FakePool {
    async connect(): Promise<FakeClient> {
      if (state.failConnect) throw new Error("PRIVATE connection URL");
      return client;
    }
    async end(): Promise<void> {
      state.ended = true;
    }
  }
  const target = createPgMigrationTarget({
    connectionString: "postgres://private",
    classification: "test",
    expected: { database: "test" },
    driverImporter: async () => ({ Pool: FakePool }) as unknown as typeof import("pg"),
    ...overrides,
  });
  return { client, state, target };
}

await describe("PostgreSQL migration adapter without an installed driver", async () => {
  await it("validates explicit target configuration and unambiguous identities", () => {
    strict.notStrictEqual(migrationCatalogKey("column", "a.b", "c"), migrationCatalogKey("column", "a", "b.c"));
    const base = { connectionString: "x", classification: "test" as const, expected: { database: "test" } };
    strict.throws(() => createPgMigrationTarget({ ...base, namespaces: [] }), /at least one/);
    strict.throws(() => createPgMigrationTarget({ ...base, namespaces: ["typed_sql"] }), /separate/);
    strict.throws(() => createPgMigrationTarget({ ...base, namespaces: ["x\0y"] }), /NUL/);
    strict.throws(() => createPgMigrationTarget({ ...base, historyNamespace: "" }), /nonempty/);
    strict.throws(() => createPgMigrationTarget({ ...base, historyNamespace: "x".repeat(64) }), /63 UTF-8 bytes/);
    strict.throws(() => createPgMigrationTarget({ ...base, namespaces: ["é".repeat(32)] }), /63 UTF-8 bytes/);
    strict.throws(() => createPgMigrationTarget({ ...base, statementTimeoutMs: 0 }), /positive/);
    strict.throws(() => createPgMigrationTarget({ ...base, lockTimeoutMs: Number.POSITIVE_INFINITY }), /positive/);
    strict.throws(() => createPgMigrationTarget({ ...base, expected: { database: "" } }), /expected database/);
    strict.throws(() => createPgMigrationTarget({ ...base, classification: "invalid" as "test" }), /classification/);
    strict.throws(() => createPgMigrationTarget({ ...base, disposable: "yes" as unknown as boolean }), /boolean/);
  });

  await it("opens lazily, keeps catalog/history read-only, and closes idempotently", async () => {
    let lookups = 0;
    const { client, state, target } = fixture({
      connectionString: () => {
        lookups += 1;
        return "postgres://private";
      },
      disposable: true,
    });
    strict.strictEqual(lookups, 0);
    strict.strictEqual(target.disposable, true);
    const session = await target.connect();
    strict.strictEqual(lookups, 1);
    strict.deepStrictEqual(await session.identity(), {
      dialect: "postgres",
      database: "test",
      server: "127.0.0.1:5432",
    });
    strict.deepStrictEqual(await session.history(), emptyHistory());
    strict.strictEqual((await session.capture()).coverage, "complete");
    strict.ok(!client.queries.some((text) => text.startsWith("create")));
    await session.close();
    await session.close();
    strict.strictEqual(state.ended, true);
    await strict.rejects(session.identity(), /closed/);
  });

  await it("requires a server lock for transaction/history mutations and observes lock loss", async () => {
    const { client, target } = fixture();
    const session = await target.connect();
    try {
      await strict.rejects(session.begin(), /Acquire/);
      await strict.rejects(session.commit(), /no active/);
      await session.rollback();
      await session.unlock();
      await session.lock(20);
      await strict.rejects(session.lock(20), /already holds/);
      await session.bootstrap();
      await session.begin();
      await strict.rejects(session.begin(), /already active/);
      await strict.rejects(session.unlock(), /Finish/);
      await session.saveHistory(emptyHistory());
      await session.commit();
      await session.begin();
      await session.rollback();
      strict.strictEqual(await session.check({ text: "select true as ok", values: [] }, "boolean"), true);
      strict.strictEqual(await session.check({ text: "select 1 where false", values: [] }, "noRows"), true);
      await session.execute({ text: "select 1; select 2", values: [] });
      session.validateReconciliation([{ text: "create table x(id integer)", values: [] }]);
      strict.throws(
        () => session.validateReconciliation([{ text: "create table x(id integer)", values: [1] }]),
        /bound data/,
      );
      client.held = false;
      await strict.rejects(session.saveHistory(emptyHistory()), /no longer confirms/);
    } finally {
      await session.close();
    }
  });

  await it("returns unknown coverage for absent scopes and does not mask corrupt ledgers", async () => {
    const { client, target } = fixture();
    const session = await target.connect();
    try {
      client.scope = [];
      strict.strictEqual((await session.capture()).coverage, "unknown");
      client.scope = [{ name: "public", usable: true }];
      client.catalog = [];
      strict.strictEqual((await session.capture()).coverage, "unknown");
      client.version = "130000";
      await strict.rejects(session.capture(), /14 or newer/);
      client.ledger = true;
      client.history = undefined;
      await strict.rejects(session.history(), /unique history/);
      client.history = { formatVersion: 999 };
      await strict.rejects(session.history(), /Unsupported/);
      client.history = emptyHistory();
      await session.lock(20);
      client.saved = false;
      await strict.rejects(session.saveHistory(emptyHistory()), /did not acknowledge/);
    } finally {
      await session.close();
    }
  });

  await it("isolates assertion errors with savepoints and discards failed cleanup connections", async () => {
    const { client, target } = fixture();
    const session = await target.connect();
    try {
      await session.lock(20);
      await session.begin();
      strict.equal(await session.check({ text: "select true as ok", values: [] }, "boolean"), true);
      strict.equal(await session.check({ text: "select 1 where false", values: [] }, "noRows"), true);
      client.failure = /select \* from/;
      await strict.rejects(session.check({ text: "select true as ok", values: [] }, "boolean"), /SQLSTATE/);
      strict.ok(client.queries.includes("rollback to savepoint typed_sql_assertion"));
      client.failure = undefined;
      await session.execute({ text: "select 1", values: [] });
      await session.rollback();
    } finally {
      await session.close();
    }

    const failed = fixture();
    const lost = await failed.target.connect();
    await lost.lock(20);
    await lost.begin();
    failed.client.failure = /select \* from|rollback to savepoint/;
    await strict.rejects(lost.check({ text: "select true as ok", values: [] }, "boolean"), /SQLSTATE/);
    await strict.rejects(lost.close(), /SQLSTATE/);
    strict.equal(failed.client.released, true);
  });

  await it("bounds lock waits and preserves cleanup through connection/SQL errors", async () => {
    const { client, state, target } = fixture();
    client.available = false;
    const session = await target.connect();
    await strict.rejects(session.lock(1), /Another migration runner/);
    client.available = true;
    await session.lock(20);
    await session.begin();
    client.failure = /rollback/;
    await strict.rejects(session.close(), (error: unknown) => !String(error).includes("PRIVATE"));
    strict.strictEqual(state.ended, true);
    const fail = fixture();
    fail.state.failConnect = true;
    await strict.rejects(fail.target.connect(), (error: unknown) => !String(error).includes("PRIVATE"));
    strict.strictEqual(fail.state.ended, true);
    const setup = fixture();
    setup.client.failure = /set_config/;
    await strict.rejects(setup.target.connect(), /SQLSTATE XX000/);
    strict.strictEqual(setup.state.ended, true);
    await strict.rejects(fixture({ connectionString: "" }).target.connect(), /Set a connection/);
    await strict.rejects(
      fixture({
        connectionString: () => {
          throw new Error("PRIVATE URL");
        },
      }).target.connect(),
      (error: unknown) => !String(error).includes("PRIVATE"),
    );
    const fatal = fixture();
    const lost = await fatal.target.connect();
    fatal.client.emit("error", new Error("PRIVATE socket detail"));
    await strict.rejects(lost.identity(), (error: unknown) => !String(error).includes("PRIVATE"));
    await lost.close();
    strict.strictEqual(fatal.client.released, true);
  });
});
