import { describe, it, strict } from "poku";
import {
  createMySql2LiveVerifier,
  createMySql2PlanInspector,
  type MySql2LiveVerifierConnection,
  type MySql2LiveVerifierPool,
  type MySql2PlanInspectorPool,
} from "../src/mysql2.js";

class VerificationPool implements MySql2LiveVerifierPool {
  prepared: string[] = [];
  closed = 0;
  released = 0;
  ended = false;

  async query<Row extends Record<string, unknown>[]>(sql: string): Promise<readonly [Row, unknown]> {
    if (sql.includes("information_schema.columns")) {
      return [
        [
          {
            tableSchema: "app",
            tableName: "users",
            columnName: "status",
            columnType: "enum('active','suspended')",
          },
        ] as unknown as Row,
        [],
      ];
    }
    return [
      [
        {
          version: "8.4.11",
          versionComment: "MySQL Community Server - GPL",
          sqlMode: "STRICT_TRANS_TABLES",
          characterSetServer: "utf8mb4",
          collationServer: "utf8mb4_0900_ai_ci",
          characterSetConnection: "utf8mb4",
          collationConnection: "utf8mb4_0900_ai_ci",
          timeZone: "+00:00",
          systemTimeZone: "UTC",
          lowerCaseTableNames: 0,
        },
      ] as unknown as Row,
      [],
    ];
  }

  async getConnection(): Promise<MySql2LiveVerifierConnection> {
    return {
      prepare: async (sql) => {
        this.prepared.push(sql);
        return {
          statement: {
            columns: [
              { name: "id", columnType: 8, flags: 1 },
              { name: "email", columnType: 253, flags: 0 },
              {
                name: "status",
                orgName: "status",
                orgTable: "users",
                schema: "app",
                columnType: 254,
                flags: 1,
              },
            ],
            parameters: [{ columnType: 8 }],
          },
          close: async () => {
            this.closed += 1;
          },
        };
      },
      release: () => {
        this.released += 1;
      },
    };
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

await describe("MySQL live verification", async () => {
  await it("uses COM_STMT_PREPARE metadata without executing values", async () => {
    const pool = new VerificationPool();
    const verifier = createMySql2LiveVerifier({ pool });
    const server = await verifier.server();
    strict.strictEqual(server.version, "8.4.11");
    strict.deepStrictEqual(server.features, [
      "product:mysql",
      "characterSetConnection:utf8mb4",
      "characterSetServer:utf8mb4",
      "collationConnection:utf8mb4_0900_ai_ci",
      "collationServer:utf8mb4_0900_ai_ci",
      "edition:community",
      "lowerCaseTableNames:0",
      "sqlMode:STRICT_TRANS_TABLES",
      "systemTimeZone:UTC",
      "timeZone:+00:00",
    ]);
    const evidence = await verifier.verify({
      fingerprint: `sha256:${"a".repeat(64)}`,
      sql: "SELECT id, email, status FROM users WHERE id = ?",
      operation: "read",
    });
    strict.deepStrictEqual(evidence.columns, [
      { index: 1, name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
      { index: 2, name: "email", databaseType: "varchar", tsType: "string", nullable: true },
      {
        index: 3,
        name: "status",
        databaseType: "enum('active','suspended')",
        tsType: '"active" | "suspended"',
        nullable: false,
      },
    ]);
    strict.deepStrictEqual(evidence.parameters, [{ index: 1, databaseType: "bigint", tsType: "bigint" }]);
    strict.deepStrictEqual(pool.prepared, ["SELECT id, email, status FROM users WHERE id = ?"]);
    strict.strictEqual(pool.closed, 1);
    strict.strictEqual(pool.released, 1);
    await verifier.close();
    strict.strictEqual(pool.ended, false);
  });
});

await describe("MySQL plan inspection", async () => {
  await it("requires samples, uses structured EXPLAIN, and removes conditions from evidence", async () => {
    let captured: { readonly sql: string; readonly values?: readonly unknown[] } | undefined;
    const pool: MySql2PlanInspectorPool = {
      async query<Row extends Record<string, unknown>[]>(sql: string) {
        if (sql.includes("VERSION()")) {
          return [
            [
              {
                version: "8.4.11",
                optimizerSwitch: "index_merge=on",
                optimizerPruneLevel: "1",
                optimizerSearchDepth: "62",
                explainJsonFormatVersion: "2",
              },
            ] as unknown as Row,
            [],
          ];
        }
        return [[{ TABLE_SCHEMA: "app", TABLE_NAME: "users", CARDINALITY: 10 }] as unknown as Row, []];
      },
      async getConnection() {
        return {
          async query<Row extends Record<string, unknown>[]>(sql: string, values?: readonly unknown[]) {
            captured = { sql, ...(values === undefined ? {} : { values }) };
            return [
              [
                {
                  EXPLAIN: JSON.stringify({
                    query_block: {
                      cost_info: { query_cost: "1.25" },
                      table: {
                        table_name: "users",
                        access_type: "ref",
                        key: "users_email_idx",
                        rows_examined_per_scan: 1,
                        attached_condition: "(`users`.`email` = 'private@example.com')",
                        cost_info: { prefix_cost: "1.25" },
                      },
                    },
                  }),
                },
              ] as unknown as Row,
              [],
            ];
          },
          release() {},
        };
      },
      async end() {},
    };
    const inspector = createMySql2PlanInspector({ pool });
    await strict.rejects(
      inspector.capture({
        fingerprint: `sha256:${"a".repeat(64)}`,
        sql: "SELECT id FROM users WHERE email = ?",
        operation: "read",
        parameterCount: 1,
      }),
      /requires explicit transient parameter samples/u,
    );
    const evidence = await inspector.capture({
      fingerprint: `sha256:${"a".repeat(64)}`,
      sql: "SELECT id FROM users WHERE email = ?",
      operation: "read",
      parameterCount: 1,
      values: ["private@example.com"],
    });
    strict.deepStrictEqual(captured, {
      sql: "EXPLAIN FORMAT=JSON SELECT id FROM users WHERE email = ?",
      values: ["private@example.com"],
    });
    strict.deepStrictEqual(evidence, {
      totalCost: 1.25,
      estimatedRows: 1,
      nodes: [
        { kind: "access:ref", relation: "users", index: "users_email_idx", estimatedRows: 1, estimatedCost: 1.25 },
      ],
    });
    strict.ok(!JSON.stringify(evidence).includes("private@example.com"));
    strict.match((await inspector.environment()).statisticsFingerprint, /^sha256:[a-f\d]{64}$/u);
  });

  await it("normalizes MySQL 8.4 JSON v2 access paths without retaining expressions", async () => {
    const pool: MySql2PlanInspectorPool = {
      async query<Row extends Record<string, unknown>[]>() {
        return [[] as unknown as Row, []];
      },
      async getConnection() {
        return {
          async query<Row extends Record<string, unknown>[]>() {
            return [
              [
                {
                  EXPLAIN: JSON.stringify({
                    query: "SELECT recognizable-secret",
                    inputs: [
                      {
                        operation: "Index range scan",
                        access_type: "index",
                        table_name: "users",
                        index_name: "users_pkey",
                        estimated_rows: 2,
                        estimated_total_cost: 3,
                      },
                    ],
                    condition: "email = 'recognizable-secret'",
                    operation: "Filter",
                    access_type: "filter",
                    estimated_rows: 2,
                    estimated_total_cost: 4,
                  }),
                },
              ] as unknown as Row,
              [],
            ];
          },
          release() {},
        };
      },
      async end() {},
    };
    const evidence = await createMySql2PlanInspector({ pool }).capture({
      fingerprint: `sha256:${"b".repeat(64)}`,
      sql: "SELECT id FROM users",
      operation: "read",
      parameterCount: 0,
    });
    strict.strictEqual(evidence.totalCost, 4);
    strict.strictEqual(evidence.estimatedRows, 2);
    strict.deepStrictEqual(evidence.nodes, [
      { kind: "access:filter", estimatedRows: 2, estimatedCost: 4 },
      { kind: "access:index", relation: "users", index: "users_pkey", estimatedRows: 2, estimatedCost: 3 },
    ]);
    strict.ok(!JSON.stringify(evidence).includes("recognizable-secret"));
  });

  await it("validates requests, releases malformed captures, and owns lazy pools", async () => {
    const pool = new VerificationPool();
    const inspector = createMySql2PlanInspector({ pool: pool as unknown as MySql2PlanInspectorPool });
    await strict.rejects(
      inspector.capture({ fingerprint: "bad", sql: "SELECT 1", operation: "read", parameterCount: 0 }),
      /SHA-256/u,
    );
    await strict.rejects(
      inspector.capture({
        fingerprint: `sha256:${"c".repeat(64)}`,
        sql: "SELECT ?",
        operation: "read",
        parameterCount: 1,
        values: [],
      }),
      /parameter count/u,
    );
    strict.strictEqual(pool.prepared.length, 0);
    await strict.rejects(createMySql2PlanInspector({}).environment(), /requires connectionUri or pool/u);

    let ended = false;
    const ownedPool = {
      async query<Row extends Record<string, unknown>[]>(sql: string) {
        if (sql.includes("VERSION()")) return [[{ version: "8.4.11" }] as unknown as Row, []] as const;
        return [[] as unknown as Row, []] as const;
      },
      async getConnection() {
        throw new Error("not used");
      },
      async end() {
        ended = true;
      },
    };
    let configuration: unknown;
    const lazy = createMySql2PlanInspector({
      connectionUri: async () => "mysql://localhost/example",
      poolConfig: { connectionLimit: 2 },
      driverImporter: async () =>
        ({
          createPool(value: unknown) {
            configuration = value;
            return ownedPool;
          },
        }) as unknown as typeof import("mysql2/promise"),
    });
    strict.strictEqual(configuration, undefined);
    strict.strictEqual((await lazy.environment()).version, "8.4.11");
    strict.deepStrictEqual(configuration, { connectionLimit: 2, uri: "mysql://localhost/example" });
    await lazy.close();
    strict.strictEqual(ended, true);

    let released = false;
    const malformed: MySql2PlanInspectorPool = {
      async query<Row extends Record<string, unknown>[]>() {
        return [[] as unknown as Row, []];
      },
      async getConnection() {
        return {
          async query<Row extends Record<string, unknown>[]>() {
            return [[{ EXPLAIN: "not-json" }] as unknown as Row, []];
          },
          release() {
            released = true;
          },
        };
      },
      async end() {},
    };
    await strict.rejects(
      createMySql2PlanInspector({ pool: malformed }).capture({
        fingerprint: `sha256:${"d".repeat(64)}`,
        sql: "SELECT 1",
        operation: "read",
        parameterCount: 0,
      }),
    );
    strict.strictEqual(released, true);
  });
});
