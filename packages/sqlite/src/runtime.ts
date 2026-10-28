import { createHash } from "node:crypto";
import {
  assertExecutionCapabilities,
  type Database,
  decodeQueryResultRows,
  decodeQueryResultStream,
  type ExecutionOptions,
  encodeQueryValues,
  getQueryValuePlan,
  hasQueryResultValidator,
  type Query,
  type QueryBatch,
  QueryCardinalityError,
  type QueryResults,
  type QueryStream,
  type QueryTransportProfile,
  queryResultValidationSource,
  type RenderedQuery,
  renderQuery,
  type StreamOptions,
  validateQueryResultBatch,
  validateQueryResultRows,
  validateQueryResultStream,
} from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import {
  createSqlitePreparedQueryState,
  prepareSqliteQuery,
  type SqlitePreparedQueryFactory,
  type SqlitePreparedQueryState,
} from "./prepared.js";
import { sqliteRenderer } from "./query.js";
import { defaultSqliteTypePolicy, type SqliteTypePolicy } from "./type-policy.js";
import { SQLITE_DIALECT_VERSION } from "./version.js";

export { sqliteRenderer } from "./query.js";

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
  readonly typePolicy?: SqliteTypePolicy;
  readonly connection: SqliteConnectionLike;
  readonly ownsConnection?: boolean;
  /** Maximum rendered cardinalities cached by each logical prepared factory. Defaults to 32. */
  readonly preparedCardinalityVariantLimit?: number;
}

function sqliteQueryFingerprint<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): string {
  const text = renderQuery(query, sqliteRenderer).text;
  return `sha256:${createHash("sha256").update(`sqlite\0${SQLITE_DIALECT_VERSION}\0${text}`).digest("hex")}`;
}

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
  readonly #profile: QueryTransportProfile;
  readonly #ownsConnection: boolean;
  readonly #transactionDepth: number;
  readonly #root: boolean;
  readonly #parent: SqliteDatabaseImplementation | undefined;
  readonly #children = new Set<SqliteDatabaseImplementation>();
  readonly #streams = new Set<QueryStream<unknown>>();
  #scopeOpen = true;
  #closed = false;
  #closing: Promise<void> | undefined;
  readonly executionCapabilities = executionCapabilities;

  constructor(
    connection: SqliteConnectionLike,
    queue: ExclusiveQueue,
    prepared: SqlitePreparedQueryState,
    profile: QueryTransportProfile,
    ownsConnection: boolean,
    transactionDepth: number,
    root: boolean,
    parent?: SqliteDatabaseImplementation,
  ) {
    this.#connection = connection;
    this.#queue = queue;
    this.#prepared = prepared;
    this.#profile = profile;
    this.#ownsConnection = ownsConnection;
    this.#transactionDepth = transactionDepth;
    this.#root = root;
    this.#parent = parent;
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
    const rendered = this.#render(query);
    const operation = (): readonly Row[] => {
      this.#assertOpen();
      return this.#connection.all(rendered.text, rendered.values) as readonly Row[];
    };
    const rows = await (this.#root ? this.#queue.run(operation) : operation());
    return this.#validateRows(query, rows);
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
      this.#assertOpen();
      const results: (readonly unknown[])[] = [];
      for (const query of snapshot) {
        const rendered = this.#render(query as Query<unknown, readonly unknown[]>);
        results.push(await this.#connection.all(rendered.text, rendered.values));
      }
      return results as QueryResults<Queries>;
    };
    const results = await (this.#root ? this.#queue.run(operation) : operation());
    return this.#validateBatch(snapshot, results);
  }

  stream<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options: StreamOptions = {},
  ): QueryStream<Row> {
    this.#assertOpen();
    validateBatchSize(options.batchSize);
    const rendered = this.#render(query);
    let source!: QueryStream<Row>;
    source = new SqliteQueryStream<Row>(async () => {
      this.#assertOpen();
      this.#assertNoStream("start a query stream");
      const release = this.#root ? await this.#queue.acquire() : () => undefined;
      try {
        this.#assertOpen();
        const iterator = this.#connection.iterate(rendered.text, rendered.values)[Symbol.iterator]() as Iterator<Row>;
        this.#streams.add(source as QueryStream<unknown>);
        return {
          iterator,
          release: () => {
            this.#streams.delete(source as QueryStream<unknown>);
            release();
          },
        };
      } catch (error) {
        release();
        throw error;
      }
    });
    const decoded =
      getQueryValuePlan(query) === undefined ? source : decodeQueryResultStream(query, source, this.#profile);
    return hasQueryResultValidator(query)
      ? validateQueryResultStream(query, decoded, sqliteQueryFingerprint(query))
      : decoded;
  }

  #render<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): RenderedQuery {
    const prepared = this.#prepared.queries.get(queryResultValidationSource(query));
    const rendered = prepared?.rendered ?? renderQuery(query, sqliteRenderer);
    return getQueryValuePlan(query) === undefined
      ? rendered
      : { text: rendered.text, values: encodeQueryValues(query, rendered.values, this.#profile) };
  }

  #validateRows<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    rows: readonly unknown[],
  ): readonly Row[] | Promise<readonly Row[]> {
    const decoded =
      getQueryValuePlan(query) === undefined
        ? (rows as readonly Row[])
        : decodeQueryResultRows(query, rows, this.#profile);
    if (!hasQueryResultValidator(query)) return decoded;
    return validateQueryResultRows(query, decoded, sqliteQueryFingerprint(query));
  }

  async #validateBatch<const Queries extends readonly unknown[]>(
    queries: QueryBatch<Queries>,
    results: QueryResults<Queries>,
  ): Promise<QueryResults<Queries>> {
    const list = queries as unknown as readonly Query<unknown>[];
    if (!list.some((query) => getQueryValuePlan(query) !== undefined))
      return validateQueryResultBatch(queries, results, (query) => sqliteQueryFingerprint(query));
    const validated: (readonly unknown[])[] = [];
    const resultList = results as readonly (readonly unknown[])[];
    for (let index = 0; index < list.length; index++)
      validated.push(await this.#validateRows(list[index]!, resultList[index]!));
    return validated as QueryResults<Queries>;
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
      this.#assertOpen();
      const depth = this.#transactionDepth + 1;
      const savepoint = `typed_sql_${depth}`;
      const scope = new SqliteDatabaseImplementation(
        this.#connection,
        this.#queue,
        this.#prepared,
        this.#profile,
        false,
        depth,
        false,
        this,
      );
      this.#children.add(scope);
      let began = false;
      try {
        this.#connection.exec(this.#transactionDepth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
        began = true;
        const result = await fn(scope);
        scope.#scopeOpen = false;
        if (scope.#children.size > 0) {
          throw new Error(
            "SQLite transaction callback returned with an active child transaction; await nested work before returning",
          );
        }
        await scope.#closeStreams();
        if (!this.#scopeIsOpen()) throw new Error("SQLite transaction scope is closed");
        this.#connection.exec(this.#transactionDepth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        scope.#scopeOpen = false;
        await scope.#closeStreams().catch(() => undefined);
        try {
          if (began && this.#scopeIsOpen()) {
            if (this.#transactionDepth === 0) this.#connection.exec("ROLLBACK");
            else {
              this.#connection.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              this.#connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
            }
          }
        } catch {
          // Preserve the callback or query failure.
        }
        throw error;
      } finally {
        this.#children.delete(scope);
      }
    };
    return this.#root ? this.#queue.run(operation) : operation();
  }

  async close(): Promise<void> {
    if (!this.#root) throw new Error("Transaction-scoped SQLite databases do not own connection lifecycle");
    this.#closing ??= (async () => {
      await this.#closeStreams();
      await this.#queue.run(() => {
        this.#closed = true;
        if (this.#ownsConnection) this.#connection.close?.();
      });
    })();
    return this.#closing;
  }

  async #closeStreams(): Promise<void> {
    await Promise.all([...this.#children].map((child) => child.#closeStreams()));
    const streams = [...this.#streams];
    await Promise.all(streams.map((stream) => stream.close()));
  }

  #assertNoStream(operation: string): void {
    if (!this.#root && this.#children.size > 0)
      throw new Error(`Cannot ${operation} while a SQLite child transaction is active`);
    if (this.#streams.size > 0) throw new Error(`Cannot ${operation} while a SQLite query stream is active`);
  }

  #assertOpen(): void {
    if (this.#closed || this.#closing !== undefined) throw new Error("SQLite database is closed");
    if (!this.#scopeIsOpen()) throw new Error("SQLite transaction scope is closed");
  }

  #scopeIsOpen(): boolean {
    return this.#scopeOpen && !this.#closed && (this.#parent === undefined || this.#parent.#scopeIsOpen());
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
    createSqlitePreparedQueryState(options.preparedCardinalityVariantLimit),
    Object.freeze({
      id: "sqlite",
      dialect: "sqlite",
      integer: "lossless",
      jsonWire: "text",
      typePolicyHash: calculateTypePolicyHash(options.typePolicy ?? defaultSqliteTypePolicy),
    }),
    options.ownsConnection ?? false,
    0,
    true,
  );
}

export type { SqlitePreparedQueryFactory } from "./prepared.js";
