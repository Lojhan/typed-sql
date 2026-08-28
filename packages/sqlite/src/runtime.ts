import {
  assertExecutionCapabilities,
  type Database,
  type ExecutionOptions,
  type Query,
  type QueryBatch,
  QueryCardinalityError,
  type QueryResults,
  type QueryStream,
  renderQuery,
  type SqlRenderer,
  type StreamOptions,
} from "@typed-sql/core";
import {
  createSqlitePreparedQueryState,
  prepareSqliteQuery,
  type SqlitePreparedQueryFactory,
  type SqlitePreparedQueryState,
} from "./prepared.js";

export interface SqliteConnectionLike {
  all(sql: string, values?: readonly unknown[]): readonly Record<string, unknown>[];
  exec(sql: string): void;
  iterate(sql: string, values?: readonly unknown[]): Iterable<Record<string, unknown>>;
  close?(): void;
}

export interface SqliteTransaction extends Database<SqliteTransaction> {
  batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
  stream<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, options?: StreamOptions): QueryStream<Row>;
  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): SqlitePreparedQueryFactory<Arguments, Row, Params>;
}

export interface SqliteDatabase extends Database<SqliteTransaction> {
  batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
  stream<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, options?: StreamOptions): QueryStream<Row>;
  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): SqlitePreparedQueryFactory<Arguments, Row, Params>;
  close(): Promise<void>;
}

export interface SqliteDatabaseOptions {
  readonly connection: SqliteConnectionLike;
  readonly ownsConnection?: boolean;
}

export const sqliteRenderer: SqlRenderer = Object.freeze({
  placeholder: () => "?",
  quoteIdentifier: (identifier: string) => `"${identifier.replaceAll('"', '""')}"`,
});

const executionCapabilities = Object.freeze({ cancellation: false, deadlines: false });
const emptyBatchResults = Object.freeze([]);

class ExclusiveQueue {
  #tail = Promise.resolve();

  async acquire(): Promise<() => void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  async run<Value>(operation: () => Value | Promise<Value>): Promise<Value> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function validateBatchSize(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError("SQLite stream batchSize must be a positive safe integer");
  }
}

class SqliteQueryStream<Row> implements QueryStream<Row> {
  readonly #start: () => Promise<{ readonly iterator: Iterator<Row>; readonly release: () => void }>;
  #state: Promise<{ readonly iterator: Iterator<Row>; readonly release: () => void }> | undefined;
  #closed = false;

  constructor(start: () => Promise<{ readonly iterator: Iterator<Row>; readonly release: () => void }>) {
    this.#start = start;
  }

  [Symbol.asyncIterator](): QueryStream<Row> {
    return this;
  }

  async next(): Promise<IteratorResult<Row>> {
    if (this.#closed) return { done: true, value: undefined };
    this.#state ??= this.#start();
    const state = await this.#state;
    try {
      const result = state.iterator.next();
      if (result.done) await this.close();
      return result;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async return(): Promise<IteratorResult<Row>> {
    await this.close();
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<Row>> {
    await this.close();
    throw error;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#state === undefined) return;
    const state = await this.#state;
    try {
      state.iterator.return?.();
    } finally {
      state.release();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

class SqliteDatabaseImplementation implements SqliteDatabase, SqliteTransaction {
  readonly #connection: SqliteConnectionLike;
  readonly #queue: ExclusiveQueue;
  readonly #prepared: SqlitePreparedQueryState;
  readonly #ownsConnection: boolean;
  readonly #transactionDepth: number;
  readonly #root: boolean;
  readonly #streams = new Set<QueryStream<unknown>>();
  #scopeOpen = true;
  #closed = false;
  readonly executionCapabilities = executionCapabilities;

  constructor(
    connection: SqliteConnectionLike,
    queue: ExclusiveQueue,
    prepared: SqlitePreparedQueryState,
    ownsConnection: boolean,
    transactionDepth: number,
    root: boolean,
  ) {
    this.#connection = connection;
    this.#queue = queue;
    this.#prepared = prepared;
    this.#ownsConnection = ownsConnection;
    this.#transactionDepth = transactionDepth;
    this.#root = root;
  }

  async execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> {
    return this.all(query);
  }

  async all<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<readonly Row[]> {
    this.#assertOpen();
    if (options !== undefined) assertExecutionCapabilities(executionCapabilities, options);
    this.#assertNoStream("execute a query");
    const prepared = this.#prepared.queries.get(query);
    const rendered = prepared?.rendered ?? renderQuery(query, sqliteRenderer);
    const operation = async (): Promise<readonly Row[]> =>
      (await this.#connection.all(rendered.text, rendered.values)) as readonly Row[];
    return this.#root ? this.#queue.run(operation) : operation();
  }

  async one<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<Row> {
    const rows = await this.all(query, options);
    if (rows.length !== 1) throw new QueryCardinalityError("one", rows.length);
    return rows[0]!;
  }

  async maybeOne<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<Row | undefined> {
    const rows = await this.all(query, options);
    if (rows.length > 1) throw new QueryCardinalityError("maybeOne", rows.length);
    return rows[0];
  }

  async batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>> {
    this.#assertOpen();
    this.#assertNoStream("execute a query batch");
    if (queries.length === 0) return emptyBatchResults as QueryResults<Queries>;
    const snapshot = [...queries] as QueryBatch<Queries>;
    const operation = async (): Promise<QueryResults<Queries>> => {
      const results: (readonly unknown[])[] = [];
      for (const query of snapshot) {
        const prepared = this.#prepared.queries.get(query as object);
        const rendered = prepared?.rendered ?? renderQuery(query as Query<unknown, readonly unknown[]>, sqliteRenderer);
        results.push(await this.#connection.all(rendered.text, rendered.values));
      }
      return results as QueryResults<Queries>;
    };
    return this.#root ? this.#queue.run(operation) : operation();
  }

  stream<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options: StreamOptions = {},
  ): QueryStream<Row> {
    this.#assertOpen();
    validateBatchSize(options.batchSize);
    const prepared = this.#prepared.queries.get(query);
    const rendered = prepared?.rendered ?? renderQuery(query, sqliteRenderer);
    let stream!: QueryStream<Row>;
    stream = new SqliteQueryStream<Row>(async () => {
      this.#assertOpen();
      this.#assertNoStream("start a query stream");
      const release = this.#root ? await this.#queue.acquire() : () => undefined;
      try {
        const iterator = this.#connection.iterate(rendered.text, rendered.values)[Symbol.iterator]() as Iterator<Row>;
        this.#streams.add(stream as QueryStream<unknown>);
        return {
          iterator,
          release: () => {
            this.#streams.delete(stream as QueryStream<unknown>);
            release();
          },
        };
      } catch (error) {
        release();
        throw error;
      }
    });
    return stream;
  }

  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): SqlitePreparedQueryFactory<Arguments, Row, Params> {
    this.#assertOpen();
    return prepareSqliteQuery(this.#prepared, sqliteRenderer, statementName, factory);
  }

  async transaction<Value>(fn: (database: SqliteTransaction) => Promise<Value>): Promise<Value> {
    this.#assertOpen();
    this.#assertNoStream("start a transaction");
    if (typeof fn !== "function") throw new TypeError("SQLite transaction callback must be a function");
    const operation = async (): Promise<Value> => {
      const depth = this.#transactionDepth + 1;
      const savepoint = `typed_sql_${depth}`;
      await this.#connection.exec(this.#transactionDepth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
      const scope = new SqliteDatabaseImplementation(
        this.#connection,
        this.#queue,
        this.#prepared,
        false,
        depth,
        false,
      );
      try {
        const result = await fn(scope);
        await scope.#closeStreams();
        scope.#scopeOpen = false;
        await this.#connection.exec(this.#transactionDepth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await scope.#closeStreams().catch(() => undefined);
        scope.#scopeOpen = false;
        try {
          if (this.#transactionDepth === 0) await this.#connection.exec("ROLLBACK");
          else {
            await this.#connection.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await this.#connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
          }
        } catch {
          // Preserve the callback or query failure.
        }
        throw error;
      }
    };
    return this.#root ? this.#queue.run(operation) : operation();
  }

  async close(): Promise<void> {
    if (!this.#root) throw new Error("Transaction-scoped SQLite databases do not own connection lifecycle");
    if (this.#closed) return;
    await this.#closeStreams();
    await this.#queue.run(async () => {
      if (this.#closed) return;
      this.#closed = true;
      if (this.#ownsConnection) await this.#connection.close?.();
    });
  }

  async #closeStreams(): Promise<void> {
    const streams = [...this.#streams];
    await Promise.all(streams.map((stream) => stream.close()));
  }

  #assertNoStream(operation: string): void {
    if (this.#streams.size > 0) throw new Error(`Cannot ${operation} while a SQLite query stream is active`);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLite database is closed");
    if (!this.#scopeOpen) throw new Error("SQLite transaction scope is closed");
  }
}

export function createSqliteDatabase(options: SqliteDatabaseOptions): SqliteDatabase {
  if (typeof options.connection?.all !== "function" || typeof options.connection.exec !== "function") {
    throw new TypeError("SQLite database requires a connection with all(), exec(), and iterate()");
  }
  if (typeof options.connection.iterate !== "function") {
    throw new TypeError("SQLite database requires a connection with all(), exec(), and iterate()");
  }
  return new SqliteDatabaseImplementation(
    options.connection,
    new ExclusiveQueue(),
    createSqlitePreparedQueryState(),
    options.ownsConnection ?? false,
    0,
    true,
  );
}

export type { SqlitePreparedQueryFactory } from "./prepared.js";
