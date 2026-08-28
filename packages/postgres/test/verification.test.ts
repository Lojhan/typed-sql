import { describe, it, strict } from "poku";
import { createPgLiveVerifier, type PgLiveVerifierClient, type PgLiveVerifierPool } from "../src/pg.js";

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
