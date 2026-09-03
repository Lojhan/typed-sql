import { describe, it, strict } from "poku";
import {
  createPgLiveVerifier,
  createPgPlanInspector,
  type PgLiveVerifierClient,
  type PgLiveVerifierPool,
} from "../src/pg.js";

class VerificationPool implements PgLiveVerifierPool {
  readonly clientQueries: string[] = [];
  readonly poolQueries: string[] = [];
  released: Error | boolean | undefined;
  ended = false;
  constructor(readonly version = "18.4") {}

  async query<Row extends Record<string, unknown>>(sql: string): Promise<{ readonly rows: readonly Row[] }> {
    this.poolQueries.push(sql);
    if (sql.includes("server_version")) return { rows: [{ version: this.version }] as unknown as readonly Row[] };
    return { rows: [{ extension: "plpgsql:1.0" }] as unknown as readonly Row[] };
  }

  async connect(): Promise<PgLiveVerifierClient> {
    return {
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        this.clientQueries.push(sql);
        if (sql.includes("FROM pg_prepared_statements")) {
          return {
            rows: [
              {
                parameterTypes: ["bigint"],
                ...(this.version.startsWith("18") ? { resultTypes: ["bigint", "text"] } : {}),
              },
            ] as unknown as readonly Row[],
          };
        }
        return { rows: [] };
      },
      release: (error) => {
        this.released = error;
      },
    };
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

await describe("PostgreSQL live verification", async () => {
  await it("uses prepare metadata without executing the statement and always deallocates", async () => {
    const pool = new VerificationPool();
    const verifier = createPgLiveVerifier({ pool });
    const evidence = await verifier.verify({
      fingerprint: `sha256:${"a".repeat(64)}`,
      sql: "UPDATE users SET email = $1 RETURNING id, email",
      operation: "write",
    });
    strict.deepStrictEqual(evidence.parameters, [{ index: 1, databaseType: "bigint", tsType: "bigint" }]);
    strict.deepStrictEqual(evidence.columns, [
      { index: 1, databaseType: "bigint", tsType: "bigint" },
      { index: 2, databaseType: "text", tsType: "string" },
    ]);
    strict.match(pool.clientQueries[0]!, /^PREPARE typed_sql_/u);
    strict.match(pool.clientQueries.at(-1)!, /^DEALLOCATE typed_sql_/u);
    strict.ok(!pool.clientQueries.some((query) => query.startsWith("EXECUTE")));
    strict.strictEqual(pool.released, undefined);
    strict.deepStrictEqual(await verifier.server(), await verifier.server());
    await verifier.close();
    strict.strictEqual(pool.ended, false);
  });

  await it("reports PostgreSQL 17 result metadata as unavailable", async () => {
    const verifier = createPgLiveVerifier({ pool: new VerificationPool("17.8") });
    const evidence = await verifier.verify({
      fingerprint: `sha256:${"b".repeat(64)}`,
      sql: "SELECT id FROM users WHERE id = $1",
      operation: "read",
    });
    strict.deepStrictEqual(evidence.unavailable, ["columns"]);
    strict.strictEqual(evidence.parameters.length, 1);
  });

  await it("describes result metadata through the value-free protocol on PostgreSQL 14-17", async () => {
    const pool = new VerificationPool("14.24");
    const protocol: string[] = [];
    let parameterListener: ((message: { readonly dataTypeIDs: readonly number[] }) => void) | undefined;
    const connection = {
      parse({ name }: { readonly name: string }) {
        protocol.push(`parse:${name}`);
      },
      describe({ name }: { readonly name: string }) {
        protocol.push(`describe:${name}`);
      },
      sync() {
        protocol.push("sync");
      },
      on(_event: string, listener: typeof parameterListener) {
        parameterListener = listener;
      },
      off() {
        parameterListener = undefined;
      },
    };
    type MockConnection = typeof connection;
    pool.connect = async () =>
      ({
        connection,
        query: async (value: unknown, callback?: (error?: unknown) => void) => {
          if (typeof value === "string") {
            pool.clientQueries.push(value);
            if (value.includes("FROM pg_type")) {
              return {
                rows: [
                  { oid: 20, databaseType: "bigint" },
                  { oid: 25, databaseType: "text" },
                ],
              };
            }
            return { rows: [] };
          }
          const query = value as {
            callback: ((error?: unknown) => void) | undefined;
            submit(connection: MockConnection): void;
            handleRowDescription(message: { readonly fields: readonly { name: string; dataTypeID: number }[] }): void;
            handleReadyForQuery(): void;
          };
          query.callback = callback;
          query.submit(connection);
          parameterListener?.({ dataTypeIDs: [20] });
          query.handleRowDescription({
            fields: [
              { name: "id", dataTypeID: 20 },
              { name: "email", dataTypeID: 25 },
            ],
          });
          query.handleReadyForQuery();
          return undefined;
        },
        release: (error: Error | boolean | undefined) => {
          pool.released = error;
        },
      }) as unknown as PgLiveVerifierClient;
    const verifier = createPgLiveVerifier({ pool });
    const evidence = await verifier.verify({
      fingerprint: `sha256:${"c".repeat(64)}`,
      sql: "SELECT id, email FROM users WHERE id = $1",
      operation: "read",
    });
    strict.deepStrictEqual(evidence, {
      parameters: [{ index: 1, databaseType: "bigint", tsType: "bigint" }],
      columns: [
        { index: 1, name: "id", databaseType: "bigint", tsType: "bigint" },
        { index: 2, name: "email", databaseType: "text", tsType: "string" },
      ],
    });
    strict.deepStrictEqual(
      protocol.map((entry) => entry.split(":")[0]),
      ["parse", "describe", "sync"],
    );
    strict.ok(!pool.clientQueries.some((query) => query.startsWith("PREPARE") || query.startsWith("EXECUTE")));
  });

  await it("rejects malformed fingerprints before acquiring a connection", async () => {
    const pool = new VerificationPool();
    const verifier = createPgLiveVerifier({ pool });
    await strict.rejects(
      verifier.verify({ fingerprint: "not-a-fingerprint", sql: "SELECT 1", operation: "read" }),
      /SHA-256/u,
    );
    strict.deepStrictEqual(pool.clientQueries, []);
  });

  await it("requires either an injected pool or an application-owned connection", async () => {
    const verifier = createPgLiveVerifier({});
    await strict.rejects(verifier.server(), /requires connectionString or pool/u);
  });

  await it("lazily owns and closes an application-created pool", async () => {
    let ownedPool: VerificationPool | undefined;
    let configuration: unknown;
    class Pool extends VerificationPool {
      constructor(value: unknown) {
        super();
        configuration = value;
        ownedPool = this;
      }
    }
    const verifier = createPgLiveVerifier({
      connectionString: async () => "postgresql://localhost/example",
      poolConfig: { max: 2 },
      driverImporter: async () => ({ Pool }) as unknown as typeof import("pg"),
    });
    strict.strictEqual(ownedPool, undefined);
    strict.strictEqual((await verifier.server()).version, "18.4");
    strict.deepStrictEqual(configuration, { max: 2, connectionString: "postgresql://localhost/example" });
    await verifier.close();
    strict.strictEqual(ownedPool?.ended, true);
  });

  await it("reports missing prepared metadata and still deallocates", async () => {
    const pool = new VerificationPool();
    pool.connect = async () => ({
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        pool.clientQueries.push(sql);
        return { rows: [] as readonly Row[] };
      },
      release: (error) => {
        pool.released = error;
      },
    });
    const verifier = createPgLiveVerifier({ pool });
    await strict.rejects(
      verifier.verify({ fingerprint: `sha256:${"c".repeat(64)}`, sql: "SELECT 1", operation: "read" }),
      /metadata was not returned/u,
    );
    strict.match(pool.clientQueries.at(-1)!, /^DEALLOCATE/u);
  });

  await it("marks a connection unusable when deallocation fails", async () => {
    const pool = new VerificationPool();
    pool.connect = async () => ({
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        pool.clientQueries.push(sql);
        if (sql.startsWith("DEALLOCATE")) throw new Error("cleanup failed");
        if (sql.includes("FROM pg_prepared_statements")) {
          return { rows: [{ parameterTypes: [], resultTypes: [] }] as unknown as readonly Row[] };
        }
        return { rows: [] };
      },
      release: (error) => {
        pool.released = error;
      },
    });
    const verifier = createPgLiveVerifier({ pool });
    await strict.rejects(
      verifier.verify({ fingerprint: `sha256:${"d".repeat(64)}`, sql: "SELECT 1", operation: "read" }),
      /cleanup failed/u,
    );
    strict.ok(pool.released instanceof Error);
  });
});

await describe("PostgreSQL plan inspection", async () => {
  await it("uses structured generic EXPLAIN without executing and normalizes safe evidence", async () => {
    const calls: { readonly sql: string; readonly values?: readonly unknown[] }[] = [];
    let released: Error | boolean | undefined;
    const pool: PgLiveVerifierPool = {
      async query<Row extends Record<string, unknown>>(sql: string) {
        if (sql.includes("current_setting")) {
          return { rows: [{ version: "18.4" }] as unknown as readonly Row[] };
        }
        if (sql.includes("pg_settings")) {
          return {
            rows: [
              { name: "plan_cache_mode", setting: "auto" },
              { name: "random_page_cost", setting: "4" },
            ] as unknown as readonly Row[],
          };
        }
        return { rows: [{ schemaname: "public", relname: "users", n_live_tup: "10" }] as unknown as readonly Row[] };
      },
      async connect() {
        return {
          async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
            calls.push({ sql, ...(values === undefined ? {} : { values }) });
            return {
              rows: [
                {
                  "QUERY PLAN": JSON.stringify([
                    {
                      Plan: {
                        "Node Type": "Index Scan",
                        "Relation Name": "users",
                        "Index Name": "users_pkey",
                        "Plan Rows": 1,
                        "Total Cost": 8.3,
                        "Index Cond": "(id = 'private-value')",
                      },
                    },
                  ]),
                },
              ] as unknown as readonly Row[],
            };
          },
          release(error) {
            released = error;
          },
        };
      },
      async end() {},
    };
    const inspector = createPgPlanInspector({ pool });
    const evidence = await inspector.capture({
      fingerprint: `sha256:${"a".repeat(64)}`,
      sql: "SELECT id FROM users WHERE id = $1",
      operation: "read",
      parameterCount: 1,
    });
    strict.match(calls[0]!.sql, /^EXPLAIN \(GENERIC_PLAN TRUE, FORMAT JSON\)/u);
    strict.deepStrictEqual(evidence, {
      totalCost: 8.3,
      estimatedRows: 1,
      nodes: [{ kind: "Index Scan", relation: "users", index: "users_pkey", estimatedRows: 1, estimatedCost: 8.3 }],
    });
    strict.ok(!JSON.stringify(evidence).includes("private-value"));
    strict.match((await inspector.environment()).statisticsFingerprint, /^sha256:[a-f\d]{64}$/u);
    strict.deepStrictEqual((await inspector.environment()).settings, {
      plan_cache_mode: "auto",
      random_page_cost: "4",
    });
    strict.strictEqual(released, undefined);
  });

  await it("forces a value-free generic plan on PostgreSQL 14 and 15", async () => {
    const calls: string[] = [];
    const pool: PgLiveVerifierPool = {
      async query<Row extends Record<string, unknown>>(sql: string) {
        if (sql.includes("current_setting")) return { rows: [{ version: "14.24" }] as unknown as readonly Row[] };
        return { rows: [] as readonly Row[] };
      },
      async connect() {
        return {
          async query<Row extends Record<string, unknown>>(sql: string) {
            calls.push(sql);
            return {
              rows: sql.startsWith("EXPLAIN")
                ? ([{ "QUERY PLAN": [{ Plan: { "Node Type": "Result" } }] }] as unknown as readonly Row[])
                : ([] as readonly Row[]),
            };
          },
          release() {},
        };
      },
      async end() {},
    };
    const inspector = createPgPlanInspector({ pool });
    strict.deepStrictEqual(
      await inspector.capture({
        fingerprint: `sha256:${"e".repeat(64)}`,
        sql: "SELECT $1::bigint AS id",
        operation: "read",
        parameterCount: 1,
      }),
      { nodes: [{ kind: "Result" }] },
    );
    strict.deepStrictEqual(calls, [
      "BEGIN",
      "SET LOCAL plan_cache_mode = force_generic_plan",
      `PREPARE "typed_sql_plan_${"e".repeat(32)}" AS SELECT $1::bigint AS id`,
      `EXPLAIN (FORMAT JSON) EXECUTE "typed_sql_plan_${"e".repeat(32)}"(NULL)`,
      `DEALLOCATE "typed_sql_plan_${"e".repeat(32)}"`,
      "ROLLBACK",
    ]);
    strict.ok(calls.every((sql) => !/ANALYZE/iu.test(sql)));
  });

  await it("binds transient samples but never requests ANALYZE", async () => {
    let captured: { readonly sql: string; readonly values?: readonly unknown[] } | undefined;
    const pool: PgLiveVerifierPool = {
      async query<Row extends Record<string, unknown>>() {
        return { rows: [] as readonly Row[] };
      },
      async connect() {
        return {
          async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
            captured = { sql, ...(values === undefined ? {} : { values }) };
            return {
              rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Result" } }] }] as unknown as readonly Row[],
            };
          },
          release() {},
        };
      },
      async end() {},
    };
    const inspector = createPgPlanInspector({ pool });
    await inspector.capture({
      fingerprint: `sha256:${"b".repeat(64)}`,
      sql: "UPDATE users SET email = $1",
      operation: "write",
      parameterCount: 1,
      values: ["private@example.com"],
    });
    strict.match(captured!.sql, /^EXPLAIN \(FORMAT JSON\) UPDATE/u);
    strict.ok(!captured!.sql.includes("ANALYZE"));
    strict.deepStrictEqual(captured!.values, ["private@example.com"]);
  });

  await it("validates requests, reports malformed native plans, and owns lazy pools", async () => {
    const pool = new VerificationPool();
    const inspector = createPgPlanInspector({ pool });
    await strict.rejects(
      inspector.capture({ fingerprint: "bad", sql: "SELECT 1", operation: "read", parameterCount: 0 }),
      /SHA-256/u,
    );
    await strict.rejects(
      inspector.capture({
        fingerprint: `sha256:${"c".repeat(64)}`,
        sql: "SELECT $1",
        operation: "read",
        parameterCount: 1,
        values: [],
      }),
      /parameter count/u,
    );
    strict.strictEqual(pool.clientQueries.length, 0);
    await strict.rejects(createPgPlanInspector({}).environment(), /requires connectionString or pool/u);

    let owned: VerificationPool | undefined;
    class Pool extends VerificationPool {
      constructor(readonly configuration: unknown) {
        super();
        owned = this;
      }
      override async query<Row extends Record<string, unknown>>(sql: string) {
        if (sql.includes("current_setting")) return { rows: [{ version: "18.4" }] as unknown as readonly Row[] };
        if (sql.includes("pg_settings")) {
          return { rows: [{ name: "plan_cache_mode", setting: "auto" }] as unknown as readonly Row[] };
        }
        return { rows: [] as readonly Row[] };
      }
    }
    const lazy = createPgPlanInspector({
      connectionString: async () => "postgresql://localhost/example",
      driverImporter: async () => ({ Pool }) as unknown as typeof import("pg"),
    });
    strict.strictEqual(owned, undefined);
    strict.strictEqual((await lazy.environment()).version, "18.4");
    await lazy.close();
    strict.strictEqual(owned?.ended, true);

    const malformed = new VerificationPool();
    const failure = new Error("unsupported-plan");
    malformed.connect = async () => ({
      async query() {
        throw failure;
      },
      release(error) {
        malformed.released = error;
      },
    });
    await strict.rejects(
      createPgPlanInspector({ pool: malformed }).capture({
        fingerprint: `sha256:${"d".repeat(64)}`,
        sql: "SELECT 1",
        operation: "read",
        parameterCount: 0,
      }),
      /unsupported-plan/u,
    );
    strict.strictEqual(malformed.released, failure);
  });
});
