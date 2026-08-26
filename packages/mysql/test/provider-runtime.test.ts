import { type Query, type QueryParameters, type QueryRow, sql } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import {
  introspectMySql,
  type MySqlQueryable,
  type MySqlQueryResult,
  MySqlSchemaProvider,
  mysqlCatalogQueries,
} from "../src/provider.js";
import {
  createMySqlDatabase,
  type MySqlConnectionLike,
  type MySqlDatabase,
  type MySqlExecutionResult,
  type MySqlPoolLike,
  type MySqlPreparedQueryFactory,
  type MySqlTransaction,
  mysqlRenderer,
} from "../src/runtime.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;
type TransactionCallbackScope = Parameters<Parameters<MySqlDatabase["transaction"]>[0]>[0];
type NestedTransactionCallbackScope = Parameters<Parameters<MySqlTransaction["transaction"]>[0]>[0];

const transactionScopeIsExact: Assert<Equal<TransactionCallbackScope, MySqlTransaction>> = true;
const nestedTransactionScopeIsExact: Assert<Equal<NestedTransactionCallbackScope, MySqlTransaction>> = true;
const transactionScopeOmitsClose: Assert<Equal<Extract<keyof MySqlTransaction, "close">, never>> = true;
const rootDatabaseRetainsClose: Assert<Equal<Extract<keyof MySqlDatabase, "close">, "close">> = true;
void [transactionScopeIsExact, nestedTransactionScopeIsExact, transactionScopeOmitsClose, rootDatabaseRetainsClose];

class CatalogClient implements MySqlQueryable {
  readonly calls: { readonly sql: string; readonly values?: readonly unknown[] }[] = [];
  database: string | null = "app";

  async query<Row extends Record<string, unknown>>(
    sqlText: string,
    values?: readonly unknown[],
  ): Promise<MySqlQueryResult<Row>> {
    this.calls.push({ sql: sqlText, ...(values === undefined ? {} : { values }) });
    let rows: readonly Record<string, unknown>[];
    if (sqlText.includes("VERSION()")) rows = [{ server_version: "8.4.11" }];
    else if (sqlText.includes("DATABASE()")) rows = [{ database_name: this.database }];
    else if (sqlText.includes("information_schema.COLUMNS"))
      rows = [
        {
          schema_name: "app",
          table_name: "users",
          column_name: "id",
          database_type: "bigint unsigned",
          is_nullable: "NO",
          default_expression: null,
        },
        {
          schema_name: "app",
          table_name: "users",
          column_name: "status",
          database_type: "enum('active','suspended')",
          is_nullable: "NO",
          default_expression: "active",
        },
        {
          schema_name: "app",
          table_name: "users",
          column_name: "budget",
          database_type: "decimal(14,2)",
          is_nullable: "YES",
          default_expression: null,
        },
        {
          schema_name: "audit",
          table_name: "users",
          column_name: "id",
          database_type: "int",
          is_nullable: "NO",
          default_expression: null,
        },
      ].filter((row) => (values ?? []).includes(row.schema_name));
    else if (sqlText.includes("information_schema.ROUTINES"))
      rows = [{ schema_name: "app", function_name: "user_count", database_return_type: "bigint" }];
    else throw new Error("unexpected catalog query");
    return { rows: rows as readonly Row[] };
  }
}

class FakeConnection implements MySqlConnectionLike {
  readonly commands: string[] = [];
  releaseCount = 0;
  rollbackCount = 0;
  failRelease = false;
  failRollback = false;
  failRollbackToSavepoint = false;
  async execute(sqlText: string): Promise<MySqlExecutionResult> {
    this.commands.push(sqlText);
    return resultRows();
  }
  async query(sqlText: string): Promise<MySqlExecutionResult> {
    this.commands.push(sqlText);
    if (this.failRollbackToSavepoint && sqlText.startsWith("ROLLBACK TO SAVEPOINT"))
      throw new Error("savepoint rollback failed");
    return { rows: [] };
  }
  async beginTransaction(): Promise<void> {
    this.commands.push("BEGIN");
  }
  async commit(): Promise<void> {
    this.commands.push("COMMIT");
  }
  async rollback(): Promise<void> {
    this.commands.push("ROLLBACK");
    this.rollbackCount += 1;
    if (this.failRollback) throw new Error("rollback failed");
  }
  release(): void {
    this.releaseCount += 1;
    if (this.failRelease) throw new Error("release failed");
  }
}

function resultRows(): MySqlExecutionResult {
  return {
    rows: [
      {
        id: "9007199254740993",
        budget: "12.50",
        created_at: "2026-01-02T03:04:05Z",
        active: 1,
        profile: { plan: "pro" },
      },
    ],
    fields: [
      { name: "id", columnType: 8 },
      { name: "budget", columnType: 246 },
      { name: "created_at", columnType: 12 },
      { name: "active", columnType: 1, columnLength: 1 },
      { name: "profile", columnType: 245 },
    ],
  };
}

class FakePool implements MySqlPoolLike {
  readonly connection = new FakeConnection();
  readonly calls: { readonly sql: string; readonly values?: readonly unknown[] }[] = [];
  ended = false;
  commandResult = false;
  async execute(sqlText: string, values?: readonly unknown[]): Promise<MySqlExecutionResult> {
    this.calls.push({ sql: sqlText, ...(values === undefined ? {} : { values }) });
    return this.commandResult ? { rows: { affectedRows: 1 } } : resultRows();
  }
  async getConnection(): Promise<MySqlConnectionLike> {
    return this.connection;
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

await describe("MySQL provider and runtime", async () => {
  await it("introspects schemas, columns, enums, defaults, functions, and server version", async () => {
    const client = new CatalogClient();
    const snapshot = await new MySqlSchemaProvider({ client, includeSchemas: ["app"] }).introspect({});
    strict.strictEqual(snapshot.dialect, "mysql");
    strict.strictEqual(snapshot.version, "8.4.11");
    strict.strictEqual(snapshot.tables.users?.columns.id?.tsType, "bigint");
    strict.strictEqual(snapshot.tables.users?.columns.status?.tsType, '"active" | "suspended"');
    strict.strictEqual(snapshot.tables.users?.columns.status?.defaultExpression, "active");
    strict.strictEqual(snapshot.tables.users?.columns.budget?.nullable, true);
    strict.strictEqual(snapshot.functions?.["app.user_count()"]?.returnType, "bigint");
    strict.ok(
      client.calls
        .filter((call) => call.values !== undefined)
        .every((call) => JSON.stringify(call.values) === '["app"]'),
    );
  });

  await it("uses the current database, supports multiple schema keys, and validates configuration", async () => {
    const current = await introspectMySql({ client: new CatalogClient() });
    strict.ok(current.tables.users !== undefined);
    const multiple = await new MySqlSchemaProvider({
      client: new CatalogClient(),
      includeSchemas: ["app", "audit"],
    }).introspect({});
    strict.ok(multiple.tables["app.users"] !== undefined);
    strict.ok(multiple.tables["audit.users"] !== undefined);
    await strict.rejects(() => new MySqlSchemaProvider().introspect({}), /injected client/);
    const noDatabase = new CatalogClient();
    noDatabase.database = null;
    await strict.rejects(() => new MySqlSchemaProvider({ client: noDatabase }).introspect({}), /at least one database/);
    strict.strictEqual(mysqlCatalogQueries.columns(2).match(/\?/gu)?.length, 2);
    strict.strictEqual(mysqlCatalogQueries.routines(2).match(/\?/gu)?.length, 2);
  });

  await it("decodes result fields according to policy and emits no rows for command headers", async () => {
    const pool = new FakePool();
    const database = createMySqlDatabase({ pool, ownsPool: true });
    const rows =
      await database.execute(
        sql<{ id: bigint; budget: string; created_at: Date; active: boolean; profile: unknown }>`SELECT values`,
      );
    strict.strictEqual(rows[0]?.id, 9_007_199_254_740_993n);
    strict.strictEqual(rows[0]?.budget, "12.50");
    strict.ok(rows[0]?.created_at instanceof Date);
    strict.strictEqual(rows[0]?.active, true);
    pool.commandResult = true;
    strict.deepStrictEqual(await database.execute(sql<never>`UPDATE users SET active = 1`), []);
    await database.close();
    strict.strictEqual(pool.ended, true);
    strict.strictEqual(mysqlRenderer.quoteIdentifier("a`b"), "`a``b`");
  });

  await it("creates lazy prepared factories that retain exact query types", async () => {
    const pool = new FakePool();
    const database = createMySqlDatabase({ pool });
    const accountById = database.prepare(
      "account-by-id",
      (id: bigint, active: boolean) =>
        sql.__typed<
          { id: bigint },
          readonly [bigint, boolean]
        >()`SELECT id FROM users WHERE id = ${id} AND active = ${active}`,
    );
    const exactFactory: Assert<
      Equal<
        typeof accountById,
        MySqlPreparedQueryFactory<[id: bigint, active: boolean], { id: bigint }, readonly [bigint, boolean]>
      >
    > = true;
    const exactRow: Assert<Equal<QueryRow<ReturnType<typeof accountById>>, { id: bigint }>> = true;
    const exactParameters: Assert<Equal<QueryParameters<ReturnType<typeof accountById>>, readonly [bigint, boolean]>> =
      true;
    void [exactFactory, exactRow, exactParameters];

    strict.strictEqual(accountById.statementName, "account-by-id");
    strict.strictEqual(pool.calls.length, 0);
    strict.throws(() => {
      // @ts-expect-error Prepared factory metadata is readonly.
      accountById.statementName = "changed";
    }, /read only|Cannot assign/);

    const rows = await database.execute(accountById(7n, true));
    strict.strictEqual(rows[0]?.id, 9_007_199_254_740_993n);
    strict.deepStrictEqual(pool.calls, [
      { sql: "SELECT id FROM users WHERE id = ? AND active = ?", values: ["7", true] },
    ]);

    await database.execute(accountById(8n, false));
    strict.deepStrictEqual(pool.calls[1], {
      sql: "SELECT id FROM users WHERE id = ? AND active = ?",
      values: ["8", false],
    });
  });

  await it("validates prepared names and reserves them at declaration", () => {
    const database = createMySqlDatabase({ pool: new FakePool() });
    strict.throws(() => database.prepare("", () => sql`SELECT 1`), /non-empty.*NUL/);
    strict.throws(() => database.prepare("bad\0name", () => sql`SELECT 1`), /non-empty.*NUL/);
    strict.throws(() => database.prepare(1 as unknown as string, () => sql`SELECT 1`), /non-empty.*NUL/);
    database.prepare("one", () => sql`SELECT 1`);
    strict.throws(() => database.prepare("one", () => sql`SELECT 1`), /already registered/);
  });

  await it("rejects structural shape changes before driver dispatch", async () => {
    const pool = new FakePool();
    const database = createMySqlDatabase({ pool });
    const dynamic = database.prepare(
      "dynamic-account",
      (projection: "id" | "email") =>
        sql.__typed<{ id?: bigint; email?: string }, readonly []>()`SELECT ${sql.raw(projection)} FROM users`,
    );

    await database.execute(dynamic("id"));
    strict.strictEqual(pool.calls.length, 1);
    strict.throws(() => dynamic("email"), /must always render the same SQL text/);
    strict.strictEqual(pool.calls.length, 1);
  });

  await it("rejects one query object carrying conflicting prepared names", () => {
    const database = createMySqlDatabase({ pool: new FakePool() });
    const shared: Query<{ id: bigint }, readonly []> = sql.__typed<{ id: bigint }, readonly []>()`SELECT id FROM users`;
    const first = database.prepare("first", () => shared);
    const second = database.prepare("second", () => shared);
    strict.strictEqual(first(), shared);
    strict.throws(() => second(), /cannot use both prepared statement "first" and "second"/);
  });

  await it("shares prepared metadata through transactions and nested transactions", async () => {
    const pool = new FakePool();
    const database = createMySqlDatabase({ pool });
    const rootPrepared = database.prepare("root-prepared", (id: bigint) => sql`SELECT id FROM users WHERE id = ${id}`);
    let transactionPrepared: MySqlPreparedQueryFactory<[email: string], unknown, readonly [string]> | undefined;

    await database.transaction(async (transaction) => {
      await transaction.execute(rootPrepared(1n));
      transactionPrepared = transaction.prepare(
        "transaction-prepared",
        (email: string) => sql`SELECT id FROM users WHERE email = ${email}`,
      );
      await transaction.transaction(async (nested) => {
        await nested.execute(transactionPrepared!("a@example.com"));
      });
    });

    await database.execute(transactionPrepared!("b@example.com"));
    strict.deepStrictEqual(pool.connection.commands, [
      "BEGIN",
      "SELECT id FROM users WHERE id = ?",
      "SAVEPOINT typed_sql_2",
      "SELECT id FROM users WHERE email = ?",
      "RELEASE SAVEPOINT typed_sql_2",
      "COMMIT",
    ]);
    strict.deepStrictEqual(pool.calls, [{ sql: "SELECT id FROM users WHERE email = ?", values: ["b@example.com"] }]);
    strict.throws(() => database.prepare("transaction-prepared", () => sql`SELECT 1`), /already registered/);
  });

  await it("caches rendering only in the database instance that prepared the query", async () => {
    const firstPool = new FakePool();
    const secondPool = new FakePool();
    const firstDatabase = createMySqlDatabase({ pool: firstPool });
    const secondDatabase = createMySqlDatabase({ pool: secondPool });
    const source = sql<{ id: bigint }>`SELECT id FROM users WHERE id = ${1n}`;
    let segmentReads = 0;
    const observed = new Proxy(source, {
      get(target, property, receiver) {
        if (property === "segments") segmentReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const prepared = firstDatabase.prepare("database-local", () => observed);
    const query = prepared();
    strict.strictEqual(segmentReads, 1);

    await firstDatabase.execute(query);
    strict.strictEqual(segmentReads, 1);
    await secondDatabase.execute(query);
    strict.strictEqual(segmentReads, 2);
    strict.deepStrictEqual(firstPool.calls, [{ sql: "SELECT id FROM users WHERE id = ?", values: ["1"] }]);
    strict.deepStrictEqual(secondPool.calls, [{ sql: "SELECT id FROM users WHERE id = ?", values: ["1"] }]);
  });

  await it("supports transactions, nested savepoints, rollback, and connection lifecycle", async () => {
    const pool = new FakePool();
    const database = createMySqlDatabase({ pool });
    await database.transaction(async (transaction) =>
      transaction.transaction(async (nested) => nested.execute(sql`SELECT 1`)),
    );
    strict.deepStrictEqual(pool.connection.commands, [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "SELECT 1",
      "RELEASE SAVEPOINT typed_sql_2",
      "COMMIT",
    ]);
    await strict.rejects(
      () =>
        database.transaction(async () => {
          throw new Error("stop");
        }),
      /stop/,
    );
    strict.ok(pool.connection.commands.includes("ROLLBACK"));
    await strict.rejects(
      () =>
        database.transaction(async (transaction) =>
          transaction.transaction(async () => {
            throw new Error("nested stop");
          }),
        ),
      /nested stop/,
    );
    strict.ok(pool.connection.commands.includes("ROLLBACK TO SAVEPOINT typed_sql_2"));
    pool.connection.failRollback = true;
    await strict.rejects(
      () =>
        database.transaction(async () => {
          throw new Error("original");
        }),
      /original/,
    );
    strict.ok(pool.connection.releaseCount > 0);
    await strict.rejects(
      () => database.transaction(async (transaction) => (transaction as typeof database).close()),
      /Cannot close/,
    );
    await database.close();
    strict.strictEqual(pool.ended, false);
  });

  await it("preserves nested failures when rolling back a savepoint also fails", async () => {
    const pool = new FakePool();
    pool.connection.failRollbackToSavepoint = true;
    pool.connection.failRelease = true;
    const database = createMySqlDatabase({ pool });

    await strict.rejects(
      () =>
        database.transaction(async (transaction) =>
          transaction.transaction(async () => {
            throw new Error("original nested failure");
          }),
        ),
      /original nested failure/,
    );

    strict.deepStrictEqual(pool.connection.commands, [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "ROLLBACK TO SAVEPOINT typed_sql_2",
      "ROLLBACK",
    ]);
    strict.strictEqual(pool.connection.rollbackCount, 1);
    strict.strictEqual(pool.connection.releaseCount, 1);
  });

  await it("preserves decoder failures across outer and nested transaction cleanup", async () => {
    const createUnsafeDatabase = (pool: FakePool) =>
      createMySqlDatabase({
        pool,
        typePolicy: { bigint: "number", decimal: "string", date: "Date", json: "unknown", tinyint1: "boolean" },
      });

    const outerPool = new FakePool();
    outerPool.connection.failRelease = true;
    outerPool.connection.failRollback = true;
    await strict.rejects(
      () => createUnsafeDatabase(outerPool).transaction(async (transaction) => transaction.execute(sql`SELECT 1`)),
      /safe integer range/,
    );
    strict.deepStrictEqual(outerPool.connection.commands, ["BEGIN", "SELECT 1", "ROLLBACK"]);
    strict.strictEqual(outerPool.connection.rollbackCount, 1);
    strict.strictEqual(outerPool.connection.releaseCount, 1);

    const nestedPool = new FakePool();
    nestedPool.connection.failRelease = true;
    nestedPool.connection.failRollbackToSavepoint = true;
    nestedPool.connection.failRollback = true;
    await strict.rejects(
      () =>
        createUnsafeDatabase(nestedPool).transaction(async (transaction) =>
          transaction.transaction(async (nested) => nested.execute(sql`SELECT 1`)),
        ),
      /safe integer range/,
    );
    strict.deepStrictEqual(nestedPool.connection.commands, [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "SELECT 1",
      "ROLLBACK TO SAVEPOINT typed_sql_2",
      "ROLLBACK",
    ]);
    strict.strictEqual(nestedPool.connection.rollbackCount, 1);
    strict.strictEqual(nestedPool.connection.releaseCount, 1);
  });

  await it("enforces lossless numeric policies and explicit decimal codecs", async () => {
    const pool = new FakePool();
    const unsafe = createMySqlDatabase({
      pool,
      typePolicy: { bigint: "number", decimal: "number", date: "string", json: "string", tinyint1: "number" },
    });
    await strict.rejects(() => unsafe.execute(sql`SELECT values`), /safe integer range/);
    strict.throws(
      () =>
        createMySqlDatabase({
          pool,
          typePolicy: { bigint: "string", decimal: "Decimal", date: "string", json: "unknown", tinyint1: "boolean" },
        }),
      /requires a decimal/,
    );
    const decimal = createMySqlDatabase({
      pool,
      typePolicy: { bigint: "string", decimal: "Decimal", date: "string", json: "string", tinyint1: "number" },
      decimal: (value) => ({ value }),
    });
    const rows = await decimal.execute(sql<{ budget: { value: string }; profile: string }>`SELECT values`);
    strict.deepStrictEqual(rows[0]?.budget, { value: "12.50" });
    strict.strictEqual(rows[0]?.profile, '{"plan":"pro"}');

    class PolicyPool extends FakePool {
      override async execute(): Promise<MySqlExecutionResult> {
        return {
          rows: [
            {
              safe: "42",
              bad_decimal: "Infinity",
              date_value: new Date("2026-01-02T00:00:00Z"),
              json_text: '{"ok":true}',
              yes: "1",
              no: 0,
              untouched: null,
            },
          ],
          fields: [
            { name: "safe", columnType: 8 },
            { name: "bad_decimal", columnType: 246 },
            { name: "date_value", columnType: 10 },
            { name: "json_text", columnType: 245 },
            { name: "yes", columnType: 1, columnLength: 1 },
            { name: "no", columnType: 1, columnLength: 1 },
          ],
        };
      }
    }
    const policyPool = new PolicyPool();
    const numbers = createMySqlDatabase({
      pool: policyPool,
      typePolicy: { bigint: "number", decimal: "number", date: "Date", json: "string", tinyint1: "boolean" },
    });
    await strict.rejects(() => numbers.execute(sql`SELECT values`), /finite number/);
    const strings = createMySqlDatabase({
      pool: policyPool,
      typePolicy: { bigint: "string", decimal: "string", date: "Date", json: "string", tinyint1: "boolean" },
    });
    const policyRows =
      await strings.execute(
        sql<{
          safe: string;
          date_value: Date;
          json_text: string;
          yes: boolean;
          no: boolean;
          untouched: null;
        }>`SELECT values`,
      );
    strict.strictEqual(policyRows[0]?.safe, "42");
    strict.ok(policyRows[0]?.date_value instanceof Date);
    strict.strictEqual(policyRows[0]?.json_text, '{"ok":true}');
    strict.strictEqual(policyRows[0]?.yes, true);
    strict.strictEqual(policyRows[0]?.no, false);
    strict.strictEqual(policyRows[0]?.untouched, null);
  });
});
