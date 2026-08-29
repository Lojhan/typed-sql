import { getAdapterCapability, type QueryStream, requireAdapterCapability, sql } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { postgresCopy } from "../src/bulk.js";
import {
  createPostgresDatabase,
  type PostgresClientLike,
  type PostgresCopyFromSink,
  type PostgresCopyToSource,
  type PostgresPoolLike,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from "../src/runtime.js";

class ByteSource implements PostgresCopyToSource {
  readonly chunks: Uint8Array[];
  closeCount = 0;
  abortCount = 0;

  constructor(chunks: readonly string[]) {
    this.chunks = chunks.map((value) => new TextEncoder().encode(value));
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
  async next(): Promise<IteratorResult<Uint8Array, undefined>> {
    const value = this.chunks.shift();
    return value === undefined ? { done: true, value: undefined } : { done: false, value };
  }
  async return(): Promise<IteratorResult<Uint8Array, undefined>> {
    await this.close();
    return { done: true, value: undefined };
  }
  async close(): Promise<void> {
    this.closeCount += 1;
  }
  async abort(): Promise<void> {
    this.abortCount += 1;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

class CopyClient implements PostgresClientLike {
  readonly commands: string[] = [];
  readonly written: Uint8Array[] = [];
  readonly copyToStatements: string[] = [];
  readonly copyFromStatements: string[] = [];
  readonly source = new ByteSource(["1,one@example.com\n", "2,two@example.com\n"]);
  releaseArguments: (Error | boolean | undefined)[] = [];
  finishCount = 0;
  abortCount = 0;
  writeError: Error | undefined;
  #rejectWrite: ((error: unknown) => void) | undefined;
  hangWrites = false;
  writeStarted = false;

  async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
    this.commands.push(typeof config === "string" ? config : config.text);
    return { rows: [] };
  }
  async openCopyFrom(statement: string): Promise<PostgresCopyFromSink> {
    this.copyFromStatements.push(statement);
    return {
      write: async (chunk) => {
        this.writeStarted = true;
        if (this.writeError !== undefined) throw this.writeError;
        if (this.hangWrites) {
          await new Promise<void>((_resolve, reject) => {
            this.#rejectWrite = reject;
          });
        }
        this.written.push(chunk);
      },
      finish: async () => {
        this.finishCount += 1;
      },
      abort: async () => {
        this.abortCount += 1;
        this.#rejectWrite?.(new Error("COPY sink aborted"));
      },
    };
  }
  async openCopyTo(statement: string): Promise<PostgresCopyToSource> {
    this.copyToStatements.push(statement);
    return this.source;
  }
  release(error?: Error | boolean): void {
    this.releaseArguments.push(error);
  }
}

class CopyPool implements PostgresPoolLike {
  readonly executionCapabilities = { cancellation: true, deadlines: true } as const;
  readonly client = new CopyClient();
  connectCount = 0;
  ensureCount = 0;

  async query(): Promise<PostgresQueryResult> {
    return { rows: [] };
  }
  async ensureCopy(): Promise<void> {
    this.ensureCount += 1;
  }
  async connect(): Promise<PostgresClientLike> {
    this.connectCount += 1;
    return this.client;
  }
  async end(): Promise<void> {}
}

const insert = (row: { readonly id: bigint; readonly email: string }) =>
  sql`INSERT INTO account (id, email) VALUES (${row.id}, ${row.email})`;

await describe("PostgreSQL COPY runtime lifecycle", async () => {
  await it("discovers COPY only on capable pools and releases a root import lease", async () => {
    const pool = new CopyPool();
    const database = createPostgresDatabase({ pool });
    const copy = requireAdapterCapability(database, postgresCopy);
    const result = await copy.copyFrom(insert, [
      { id: 1n, email: "one@example.com" },
      { id: 2n, email: "two@example.com" },
    ]);

    strict.deepStrictEqual(result.rows, 2);
    strict.strictEqual(pool.connectCount, 1);
    strict.strictEqual(pool.ensureCount, 1);
    strict.strictEqual(pool.client.finishCount, 1);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
    strict.strictEqual(
      new TextDecoder().decode(Buffer.concat(pool.client.written)),
      '"1","one@example.com"\n"2","two@example.com"\n',
    );

    const unsupported = createPostgresDatabase({
      pool: {
        query: async () => ({ rows: [] }),
        connect: async () => pool.client,
        end: async () => undefined,
      },
    });
    strict.strictEqual(getAdapterCapability(unsupported, postgresCopy), undefined);
  });

  await it("uses the transaction lease and commits only after COPY finishes", async () => {
    const pool = new CopyPool();
    await createPostgresDatabase({ pool }).transaction(async (transaction) => {
      const copy = requireAdapterCapability(transaction, postgresCopy);
      await copy.copyFrom(insert, [{ id: 1n, email: "one@example.com" }]);
      strict.deepStrictEqual(pool.client.releaseArguments, []);
    });
    strict.deepStrictEqual(pool.client.commands, ["BEGIN", "COMMIT"]);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("keeps COPY TO lazy, streams bounded native chunks, and releases on completion", async () => {
    const pool = new CopyPool();
    const copy = requireAdapterCapability(createPostgresDatabase({ pool }), postgresCopy);
    const stream: QueryStream<Uint8Array> = copy.copyTo(
      sql.__typed<{ readonly id: bigint; readonly email: string }, readonly []>()`
        SELECT id, email FROM account ORDER BY id
      `,
    );
    strict.strictEqual(pool.connectCount, 0);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    strict.strictEqual(new TextDecoder().decode(Buffer.concat(chunks)), "1,one@example.com\n2,two@example.com\n");
    strict.strictEqual(pool.connectCount, 1);
    strict.strictEqual(pool.client.source.closeCount, 1);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("closes COPY TO and releases its lease when the consumer stops early", async () => {
    const pool = new CopyPool();
    const copy = requireAdapterCapability(createPostgresDatabase({ pool }), postgresCopy);
    const stream = copy.copyTo(sql.__typed<{ readonly id: bigint }, readonly []>()`SELECT id FROM account`);
    strict.deepStrictEqual(await stream.next(), {
      done: false,
      value: new TextEncoder().encode("1,one@example.com\n"),
    });
    await stream.close();
    strict.strictEqual(pool.client.source.closeCount, 1);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("aborts COPY FROM and discards a root lease after database failure", async () => {
    const pool = new CopyPool();
    const failure = new Error("COPY constraint failure");
    pool.client.writeError = failure;
    const copy = requireAdapterCapability(createPostgresDatabase({ pool }), postgresCopy);
    await strict.rejects(() => copy.copyFrom(insert, [{ id: 1n, email: "one@example.com" }]), failure);
    strict.strictEqual(pool.client.abortCount, 1);
    strict.deepStrictEqual(pool.client.releaseArguments, [failure]);
  });

  await it("cancels an in-flight COPY FROM, aborts native work, and discards the lease", async () => {
    const pool = new CopyPool();
    pool.client.hangWrites = true;
    const controller = new AbortController();
    const copy = requireAdapterCapability(createPostgresDatabase({ pool }), postgresCopy);
    const running = copy.copyFrom(insert, [{ id: 1n, email: "one@example.com" }], {
      signal: controller.signal,
    });
    while (!pool.client.writeStarted) await Promise.resolve();
    controller.abort("request closed");
    await strict.rejects(running, (error) => {
      strict.strictEqual((error as { readonly code?: unknown }).code, "TSQL_CANCELLED");
      return true;
    });
    strict.ok(pool.client.abortCount >= 1);
    strict.ok(pool.client.releaseArguments[0] instanceof Error);
  });
});
