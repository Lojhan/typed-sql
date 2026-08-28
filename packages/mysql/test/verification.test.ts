import { describe, it, strict } from "poku";
import {
  createMySql2LiveVerifier,
  type MySql2LiveVerifierConnection,
  type MySql2LiveVerifierPool,
} from "../src/mysql2.js";

class VerificationPool implements MySql2LiveVerifierPool {
  prepared: string[] = [];
  closed = 0;
  released = 0;
  ended = false;

  async query<Row extends Record<string, unknown>[]>(): Promise<readonly [Row, unknown]> {
    return [[{ version: "8.4.11", comment: "MySQL Community", sqlMode: "STRICT_TRANS_TABLES" }] as unknown as Row, []];
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
    const evidence = await verifier.verify({
      fingerprint: `sha256:${"a".repeat(64)}`,
      sql: "SELECT id, email FROM users WHERE id = ?",
      operation: "read",
    });
    strict.deepStrictEqual(evidence.columns, [
      { index: 1, name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
      { index: 2, name: "email", databaseType: "varchar", tsType: "string", nullable: true },
    ]);
    strict.deepStrictEqual(evidence.parameters, [{ index: 1, databaseType: "bigint", tsType: "bigint" }]);
    strict.deepStrictEqual(pool.prepared, ["SELECT id, email FROM users WHERE id = ?"]);
    strict.strictEqual(pool.closed, 1);
    strict.strictEqual(pool.released, 1);
    await verifier.close();
    strict.strictEqual(pool.ended, false);
  });
});
