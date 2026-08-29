import { getAdapterCapability, requireAdapterCapability } from "@typed-sql/core";
import { sql } from "@typed-sql/mysql";
import { describe, it, strict } from "poku";
import { createMySqlBulkCapability, type MySqlBulkTransport, mysqlBulk } from "../src/bulk.js";
import {
  createMySqlDatabase,
  type MySqlConnectionLike,
  type MySqlExecutionResult,
  type MySqlPoolLike,
} from "../src/runtime.js";

function recorder() {
  const statements: string[] = [];
  const chunks: Uint8Array[] = [];
  const transport: MySqlBulkTransport = {
    async loadData(statement, source) {
      statements.push(statement);
      for await (const chunk of source) chunks.push(chunk);
    },
  };
  return { capability: createMySqlBulkCapability(transport), chunks, statements };
}

class BulkConnection implements MySqlConnectionLike {
  readonly loaded: Uint8Array[] = [];
  readonly commands: string[] = [];
  releaseCount = 0;
  destroyCount = 0;
  loadError: Error | undefined;
  loadStarted = false;
  hangLoad = false;
  #rejectLoad: ((error: unknown) => void) | undefined;

  async execute(): Promise<MySqlExecutionResult> {
    return { rows: [] };
  }
  async query(sql: string): Promise<MySqlExecutionResult> {
    this.commands.push(sql);
    return { rows: [] };
  }
  async loadData(_statement: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    this.loadStarted = true;
    if (this.loadError !== undefined) throw this.loadError;
    if (this.hangLoad) {
      await new Promise<void>((_resolve, reject) => {
        this.#rejectLoad = reject;
      });
    }
    for await (const chunk of chunks) this.loaded.push(chunk);
  }
  async beginTransaction(): Promise<void> {
    this.commands.push("BEGIN");
  }
  async commit(): Promise<void> {
    this.commands.push("COMMIT");
  }
  async rollback(): Promise<void> {
    this.commands.push("ROLLBACK");
  }
  destroy(): void {
    this.destroyCount += 1;
    this.#rejectLoad?.(new Error("connection destroyed"));
  }
  release(): void {
    this.releaseCount += 1;
  }
}

class BulkPool implements MySqlPoolLike {
  readonly executionCapabilities = { cancellation: true, deadlines: true } as const;
  readonly bulkLoad = true;
  readonly connection = new BulkConnection();
  connections = 0;

  async execute(): Promise<MySqlExecutionResult> {
    return { rows: [] };
  }
  async getConnection(): Promise<MySqlConnectionLike> {
    this.connections += 1;
    return this.connection;
  }
  async end(): Promise<void> {}
}

const rowQuery = (row: { readonly id: bigint; readonly email: string; readonly note: string | null }) =>
  sql`INSERT INTO app.account (id, email, note) VALUES (${row.id}, ${row.email}, ${row.note})`;

await describe("MySQL LOAD DATA capability", async () => {
  await it("derives a safe local-infile statement and escaped rows from a typed INSERT", async () => {
    const { capability, chunks, statements } = recorder();
    const result = await capability.loadData(rowQuery, [
      { id: 1n, email: "one@example.com", note: null },
      { id: 2n, email: "two\texample.com", note: "line\nbreak\\tail" },
    ]);
    strict.deepStrictEqual(statements, [
      "LOAD DATA LOCAL INFILE 'typed-sql-stream' INTO TABLE `app`.`account` CHARACTER SET utf8mb4 FIELDS TERMINATED BY '\\t' ESCAPED BY '\\\\' LINES TERMINATED BY '\\n' (`id`, `email`, `note`)",
    ]);
    const encoded = new TextDecoder().decode(Buffer.concat(chunks));
    strict.strictEqual(encoded, "1\tone@example.com\t\\N\n2\ttwo\\texample.com\tline\\nbreak\\\\tail\n");
    strict.deepStrictEqual(result, { rows: 2, bytes: new TextEncoder().encode(encoded).byteLength });
  });

  await it("encodes stable scalar forms and performs no transport work for empty input", async () => {
    const { capability, chunks, statements } = recorder();
    const progress: { readonly rows: number; readonly bytes: number }[] = [];
    await capability.loadData(
      (row: {
        readonly enabled: boolean;
        readonly disabled: boolean;
        readonly score: number;
        readonly missing: undefined;
        readonly text: string;
      }) => sql`
        INSERT INTO scalar_input (enabled, disabled, score, missing, text)
        VALUES (${row.enabled}, ${row.disabled}, ${row.score}, ${row.missing}, ${row.text})
      `,
      [{ enabled: true, disabled: false, score: 1.5, missing: undefined, text: "nul\0carriage\r" }],
      { chunkBytes: 1, onProgress: (value) => progress.push(value) },
    );
    const encoded = "1\t0\t1.5\t\\N\tnul\\0carriage\\r\n";
    strict.strictEqual(new TextDecoder().decode(Buffer.concat(chunks)), encoded);
    strict.deepStrictEqual(progress.at(-1), { rows: 1, bytes: new TextEncoder().encode(encoded).byteLength });

    const empty = await capability.loadData((id: bigint) => sql`INSERT INTO account (id) VALUES (${id})`, []);
    strict.deepStrictEqual(empty, { rows: 0, bytes: 0 });
    strict.strictEqual(statements.length, 1);
  });

  await it("rejects invalid chunk sizes and unstable primitive encodings", async () => {
    const { capability } = recorder();
    for (const chunkBytes of [0, 1.5]) {
      await strict.rejects(
        capability.loadData((id: bigint) => sql`INSERT INTO account (id) VALUES (${id})`, [1n], { chunkBytes }),
        /positive safe integer/u,
      );
    }
    for (const value of [Number.NEGATIVE_INFINITY, Symbol("unsupported")]) {
      await strict.rejects(
        capability.loadData((input: unknown) => sql`INSERT INTO account (value) VALUES (${input})`, [value]),
        /cannot encode/u,
      );
    }
  });

  await it("fails closed for structural drift, connection-specific text values, and invalid shapes", async () => {
    const { capability } = recorder();
    await strict.rejects(
      capability.loadData(
        (row: { readonly id: bigint; readonly alternate: boolean }) =>
          row.alternate
            ? sql`INSERT INTO archive (id) VALUES (${row.id})`
            : sql`INSERT INTO account (id) VALUES (${row.id})`,
        [
          { id: 1n, alternate: false },
          { id: 2n, alternate: true },
        ],
      ),
      /changed its structural SQL shape/u,
    );
    await strict.rejects(
      capability.loadData(
        (value: Uint8Array) => sql`INSERT INTO account (payload) VALUES (${value})`,
        [new Uint8Array([1])],
      ),
      /does not accept binary values/u,
    );
    await strict.rejects(
      capability.loadData(
        (value: Date) => sql`INSERT INTO account (created_at) VALUES (${value})`,
        [new Date("2026-01-01T00:00:00.000Z")],
      ),
      /does not accept Date values/u,
    );
    await strict.rejects(
      capability.loadData(
        (value: { readonly enabled: boolean }) => sql`INSERT INTO account (settings) VALUES (${value})`,
        [{ enabled: true }],
      ),
      /does not accept structured values/u,
    );
    await strict.rejects(
      capability.loadData((id: bigint) => sql`UPDATE account SET id = ${id}`, [1n]),
      /plain single-row INSERT/u,
    );
  });

  await it("is discovered on capable adapters and owns root and transaction leases", async () => {
    const pool = new BulkPool();
    const database = createMySqlDatabase({ pool });
    const bulk = requireAdapterCapability(database, mysqlBulk);
    await bulk.loadData(rowQuery, [{ id: 1n, email: "one@example.com", note: null }]);
    strict.strictEqual(pool.connections, 1);
    strict.strictEqual(pool.connection.releaseCount, 1);

    await database.transaction(async (transaction) => {
      await requireAdapterCapability(transaction, mysqlBulk).loadData(rowQuery, [
        { id: 2n, email: "two@example.com", note: null },
      ]);
      strict.strictEqual(pool.connection.releaseCount, 1);
    });
    strict.deepStrictEqual(pool.connection.commands, ["BEGIN", "COMMIT"]);
    strict.strictEqual(pool.connection.releaseCount, 2);

    const unsupported = createMySqlDatabase({
      pool: {
        execute: async () => ({ rows: [] }),
        getConnection: async () => pool.connection,
        end: async () => undefined,
      },
    });
    strict.strictEqual(getAdapterCapability(unsupported, mysqlBulk), undefined);
  });

  await it("destroys a root lease after LOAD DATA or producer failure", async () => {
    const pool = new BulkPool();
    const bulk = requireAdapterCapability(createMySqlDatabase({ pool }), mysqlBulk);
    const databaseFailure = new Error("LOAD DATA constraint failure");
    pool.connection.loadError = databaseFailure;
    await strict.rejects(
      () => bulk.loadData(rowQuery, [{ id: 1n, email: "one@example.com", note: null }]),
      databaseFailure,
    );
    strict.strictEqual(pool.connection.destroyCount, 1);
    strict.strictEqual(pool.connection.releaseCount, 0);

    const producerPool = new BulkPool();
    const producerBulk = requireAdapterCapability(createMySqlDatabase({ pool: producerPool }), mysqlBulk);
    const producerFailure = new Error("producer failed");
    async function* failedRows() {
      yield { id: 1n, email: "one@example.com", note: null };
      throw producerFailure;
    }
    await strict.rejects(() => producerBulk.loadData(rowQuery, failedRows()), producerFailure);
    strict.strictEqual(producerPool.connection.destroyCount, 1);
    strict.strictEqual(producerPool.connection.releaseCount, 0);
  });

  await it("cancels LOAD DATA by destroying its application-owned connection", async () => {
    const pool = new BulkPool();
    pool.connection.hangLoad = true;
    const controller = new AbortController();
    const bulk = requireAdapterCapability(createMySqlDatabase({ pool }), mysqlBulk);
    const running = bulk.loadData(rowQuery, [{ id: 1n, email: "one@example.com", note: null }], {
      signal: controller.signal,
    });
    while (!pool.connection.loadStarted) await Promise.resolve();
    controller.abort("request closed");
    await strict.rejects(running, (error) => {
      strict.strictEqual((error as { readonly code?: unknown }).code, "TSQL_CANCELLED");
      strict.strictEqual((error as Error).cause, "request closed");
      return true;
    });
    strict.strictEqual(pool.connection.destroyCount, 1);
    strict.strictEqual(pool.connection.releaseCount, 0);
  });

  await it("closes a producer exactly once when the transport rejects before consuming", async () => {
    let returns = 0;
    const failure = new Error("transport unavailable");
    const capability = createMySqlBulkCapability({
      async loadData() {
        throw failure;
      },
    });
    const rows: AsyncIterable<bigint> = {
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          async next() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return { done: false, value: 1n };
          },
          async return() {
            returns += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
    await strict.rejects(
      () => capability.loadData((id) => sql`INSERT INTO account (id) VALUES (${id})`, rows),
      failure,
    );
    strict.strictEqual(returns, 1);
  });
});
