import {
  type Database,
  type Query,
  type QueryBatch,
  type QueryResults,
  type QueryStream,
  renderQuery,
  type SqlRenderer,
  type StreamOptions,
} from "@typed-sql/core";
import {
  createPostgresPreparedQueryState,
  type PostgresPreparedQueryFactory,
  type PostgresPreparedQueryState,
  preparePostgresQuery,
} from "./prepared.js";
import { type PostgresCursorLike, PostgresQueryStream, validatePostgresStreamBatchSize } from "./stream.js";
import { defaultPostgresTypePolicy } from "./type-policy.js";

export type { PostgresPreparedQueryFactory } from "./prepared.js";
export type { PostgresCursorLike } from "./stream.js";

export interface PostgresCodecPolicy {
  readonly bigint: "bigint" | "string" | "number";
  readonly numeric: "string" | "number" | "Decimal";
  readonly date: "Date" | "string";
  readonly json: "unknown" | "JsonValue" | "string";
}

export interface PostgresTypeParserSet {
  getTypeParser(oid: number, format?: string): (value: string) => unknown;
}

export interface PostgresQueryConfig {
  readonly name?: string;
  readonly text: string;
  readonly values?: readonly unknown[];
  readonly types?: PostgresTypeParserSet;
}

export interface PostgresQueryResult {
  readonly rows: readonly Record<string, unknown>[];
}

export interface PostgresClientLike {
  query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult>;
  openCursor?(config: PostgresQueryConfig): PostgresCursorLike | Promise<PostgresCursorLike>;
  release(error?: Error | boolean): void;
}

export interface PostgresPoolLike {
  query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult>;
  ensureCursor?(): Promise<void>;
  connect(): Promise<PostgresClientLike>;
  end(): Promise<void>;
}

export interface PostgresTransaction extends Database<PostgresTransaction> {
  batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): PostgresPreparedQueryFactory<Arguments, Row, Params>;
  stream<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, options?: StreamOptions): QueryStream<Row>;
}

export interface PostgresDatabase extends Database<PostgresTransaction> {
  batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): PostgresPreparedQueryFactory<Arguments, Row, Params>;
  stream<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, options?: StreamOptions): QueryStream<Row>;
  close(): Promise<void>;
}

export interface PostgresDatabaseOptions {
  readonly pool: PostgresPoolLike;
  readonly ownsPool?: boolean;
  readonly typePolicy?: PostgresCodecPolicy;
  readonly decimal?: (value: string) => unknown;
  /** Native driver parsers used for types that typed-sql does not override. */
  readonly fallbackTypeParsers?: PostgresTypeParserSet;
}

const defaultPolicy: PostgresCodecPolicy = defaultPostgresTypePolicy;
const emptyBatchResults = Object.freeze([]);

const oids = {
  int8: 20,
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
  numeric: 1700,
  json: 114,
  jsonb: 3802,
} as const;

const arrayElementOids = new Map<number, number>([
  [1016, oids.int8],
  [1231, oids.numeric],
  [1182, oids.date],
  [1115, oids.timestamp],
  [1185, oids.timestamptz],
  [199, oids.json],
  [3807, oids.jsonb],
]);

function numberValue(input: string, label: string): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed))
    throw new RangeError(`${label} value ${input} cannot be represented as a finite number`);
  return parsed;
}

function safeIntegerValue(input: string): number {
  const parsed = numberValue(input, "bigint");
  if (!Number.isSafeInteger(parsed))
    throw new RangeError(`bigint value ${input} exceeds JavaScript's safe integer range`);
  return parsed;
}

function parsePostgresArray(source: string, transform: (value: string) => unknown): unknown[] {
  let index = source.indexOf("{");
  if (index === -1) throw new TypeError("Invalid PostgreSQL array value");
  const parseLevel = (): unknown[] => {
    if (source[index] !== "{") throw new TypeError("Invalid PostgreSQL array nesting");
    index += 1;
    const result: unknown[] = [];
    while (index < source.length && source[index] !== "}") {
      if (source[index] === "{") result.push(parseLevel());
      else {
        const quoted = source[index] === '"';
        if (quoted) index += 1;
        let item = "";
        while (index < source.length) {
          const char = source[index]!;
          if (char === "\\") {
            index += 1;
            item += source[index] ?? "";
            index += 1;
          } else if (quoted ? char === '"' : char === "," || char === "}") {
            if (quoted) index += 1;
            break;
          } else {
            item += char;
            index += 1;
          }
        }
        result.push(!quoted && item === "NULL" ? null : transform(item));
      }
      if (source[index] === ",") index += 1;
    }
    if (source[index] !== "}") throw new TypeError("Unterminated PostgreSQL array value");
    index += 1;
    return result;
  };
  return parseLevel();
}

export function createPostgresTypeParsers(
  policy: PostgresCodecPolicy = defaultPolicy,
  decimal?: (value: string) => unknown,
  fallback?: PostgresTypeParserSet,
): PostgresTypeParserSet {
  const scalar = new Map<number, (value: string) => unknown>();
  scalar.set(oids.int8, policy.bigint === "bigint" ? BigInt : policy.bigint === "number" ? safeIntegerValue : String);
  if (policy.numeric === "Decimal") {
    if (decimal === undefined) throw new TypeError("numeric=Decimal requires a decimal(value) codec");
    scalar.set(oids.numeric, decimal);
  } else scalar.set(oids.numeric, policy.numeric === "number" ? (input) => numberValue(input, "numeric") : String);
  for (const oid of [oids.date, oids.timestamp, oids.timestamptz]) {
    scalar.set(oid, policy.date === "string" ? String : (input) => new Date(input));
  }
  for (const oid of [oids.json, oids.jsonb]) scalar.set(oid, policy.json === "string" ? String : JSON.parse);
  return {
    getTypeParser(oid: number, format = "text") {
      if (format === "binary") return fallback?.getTypeParser(oid, format) ?? ((input: string): string => input);
      const parser = scalar.get(oid);
      if (parser !== undefined) return parser;
      const elementParser = scalar.get(arrayElementOids.get(oid) ?? -1);
      if (elementParser !== undefined) return (input: string) => parsePostgresArray(input, elementParser);
      return fallback?.getTypeParser(oid, format) ?? String;
    },
  };
}

export const postgresRenderer: SqlRenderer = Object.freeze({
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (name: string) => `"${name.replaceAll('"', '""')}"`,
});

function encodeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return Array.isArray(value) ? value.map(encodeValue) : value;
}

class PostgresDatabaseImplementation implements PostgresDatabase {
  readonly #pool: PostgresPoolLike;
  readonly #client: PostgresClientLike | undefined;
  readonly #parsers: PostgresTypeParserSet;
  readonly #ownsPool: boolean;
  readonly #prepared: PostgresPreparedQueryState;
  readonly #transactionDepth: number;
  #transactionScopeOpen = true;
  #transactionOperationFailed = false;
  #transactionOperationError: unknown;
  readonly #transactionState: {
    activeBatch: Promise<unknown> | undefined;
    readonly activeExecutes: Set<Promise<unknown>>;
    readonly activeStreams: Set<QueryStream<unknown>>;
    discardLease: boolean;
    firstDatabaseOperationError: unknown;
    unsafe: boolean;
    unsafeDepth: number | undefined;
    unsafeError: unknown;
    valid: boolean;
  };
  readonly #transactionExecutes = new Set<Promise<unknown>>();
  readonly #transactionStreams = new Set<QueryStream<unknown>>();

  constructor(
    pool: PostgresPoolLike,
    client: PostgresClientLike | undefined,
    parsers: PostgresTypeParserSet,
    ownsPool: boolean,
    depth: number,
    prepared: PostgresPreparedQueryState,
    transactionState = {
      activeBatch: undefined as Promise<unknown> | undefined,
      activeExecutes: new Set<Promise<unknown>>(),
      activeStreams: new Set<QueryStream<unknown>>(),
      discardLease: false,
      firstDatabaseOperationError: undefined as unknown,
      unsafe: false,
      unsafeDepth: undefined as number | undefined,
      unsafeError: undefined as unknown,
      valid: true,
    },
  ) {
    this.#pool = pool;
    this.#client = client;
    this.#parsers = parsers;
    this.#ownsPool = ownsPool;
    this.#transactionDepth = depth;
    this.#prepared = prepared;
    this.#transactionState = transactionState;
  }

  async execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> {
    this.#assertTransactionScopeOpen();
    this.#rejectOperationDuringTransactionStream("execute another query");
    this.#rejectOperationDuringTransactionBatch("execute another query");
    const config = this.#queryConfig(query);
    let operation: Promise<PostgresQueryResult>;
    try {
      operation = (this.#client ?? this.#pool).query(config);
    } catch (error) {
      this.#recordTransactionOperationFailure(error);
      throw error;
    }
    if (this.#client !== undefined) {
      this.#transactionExecutes.add(operation);
      this.#transactionState.activeExecutes.add(operation);
    }
    try {
      const result = await operation;
      return result.rows as readonly Row[];
    } catch (error) {
      this.#recordTransactionOperationFailure(error);
      throw error;
    } finally {
      this.#transactionExecutes.delete(operation);
      this.#transactionState.activeExecutes.delete(operation);
    }
  }

  async batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>> {
    this.#assertTransactionScopeOpen();
    this.#rejectOperationDuringTransactionStream("execute a query batch");
    this.#rejectOperationDuringTransactionBatch("execute another query batch");
    if (queries.length === 0) return emptyBatchResults as QueryResults<Queries>;
    const querySnapshot = [...queries] as unknown as QueryBatch<Queries>;
    if (this.#client !== undefined) {
      const operation = this.#executeBatch(this.#client, querySnapshot);
      this.#transactionState.activeBatch = operation;
      try {
        return await operation;
      } catch (error) {
        this.#recordTransactionOperationFailure(error);
        throw error;
      } finally {
        if (this.#transactionState.activeBatch === operation) this.#transactionState.activeBatch = undefined;
      }
    }

    const client = await this.#pool.connect();
    let results: QueryResults<Queries>;
    try {
      results = await this.#executeBatch(client, querySnapshot);
    } catch (error) {
      try {
        client.release(error instanceof Error ? error : true);
      } catch {
        /* Preserve the first query failure. */
      }
      throw error;
    }
    client.release();
    return results;
  }

  stream<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options: StreamOptions = {},
  ): QueryStream<Row> {
    this.#assertTransactionScopeOpen();
    this.#rejectOperationDuringTransactionStream("start another query stream");
    this.#rejectOperationDuringTransactionBatch("start a query stream");
    const batchSize = validatePostgresStreamBatchSize(options.batchSize);
    const config = this.#queryConfig(query);
    let stream: QueryStream<Row>;
    stream = new PostgresQueryStream<Row>({
      batchSize,
      start: async () => {
        await this.#pool.ensureCursor?.();
        const client = this.#client ?? (await this.#pool.connect());
        const release =
          this.#client === undefined
            ? (cleanupError?: unknown): void =>
                client.release(
                  cleanupError === undefined ? undefined : cleanupError instanceof Error ? cleanupError : true,
                )
            : undefined;
        if (client.openCursor === undefined) {
          try {
            release?.();
          } catch {
            /* The missing-capability failure remains primary. */
          }
          throw new Error(
            "PostgreSQL streaming requires the application-owned pg-cursor package. Install it with: pnpm add pg-cursor",
          );
        }
        try {
          const cursor = await client.openCursor(config);
          return { cursor, ...(release === undefined ? {} : { release }) };
        } catch (error) {
          this.#recordTransactionOperationFailure(error);
          try {
            release?.(error);
          } catch {
            /* Preserve cursor creation or optional-dependency failures. */
          }
          throw error;
        }
      },
      ...(this.#client === undefined
        ? {}
        : {
            onStart: () => {
              this.#assertTransactionScopeOpen();
              this.#rejectOperationDuringTransactionStream("start another query stream");
              this.#rejectOperationDuringTransactionBatch("start a query stream");
              this.#transactionState.activeStreams.add(stream as QueryStream<unknown>);
            },
            onClose: () => {
              this.#transactionState.activeStreams.delete(stream as QueryStream<unknown>);
              this.#transactionStreams.delete(stream as QueryStream<unknown>);
            },
            onError: (error: unknown) => this.#recordTransactionOperationFailure(error),
          }),
    });
    if (this.#client !== undefined) this.#transactionStreams.add(stream as QueryStream<unknown>);
    return stream;
  }

  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): PostgresPreparedQueryFactory<Arguments, Row, Params> {
    this.#assertTransactionScopeOpen();
    return preparePostgresQuery(this.#prepared, postgresRenderer, statementName, factory);
  }

  async transaction<T>(fn: (db: PostgresTransaction) => Promise<T>): Promise<T> {
    this.#assertTransactionScopeOpen();
    this.#rejectOperationDuringTransactionStream("start a nested transaction");
    this.#rejectOperationDuringTransactionBatch("start a nested transaction");
    if (this.#client !== undefined) return this.#nestedTransaction(fn);
    const client = await this.#pool.connect();
    const scope = new PostgresDatabaseImplementation(this.#pool, client, this.#parsers, false, 1, this.#prepared, {
      activeBatch: undefined,
      activeExecutes: new Set(),
      activeStreams: new Set(),
      discardLease: false,
      firstDatabaseOperationError: undefined,
      unsafe: false,
      unsafeDepth: undefined,
      unsafeError: undefined,
      valid: true,
    });
    let result: T;
    try {
      try {
        await client.query("BEGIN");
      } catch (error) {
        scope.#recordTransactionOperationFailure(error);
        throw error;
      }
      try {
        result = await fn(scope);
      } finally {
        scope.#transactionScopeOpen = false;
        scope.#transactionState.valid = false;
      }
      scope.#throwIfTransactionCannotCommit();
      await scope.#rejectLeakedTransactionWork();
      try {
        await client.query("COMMIT");
      } catch (error) {
        scope.#recordTransactionOperationFailure(error);
        throw error;
      }
    } catch (error) {
      scope.#transactionScopeOpen = false;
      scope.#transactionState.valid = false;
      await scope.#settleTransactionExecutesPreservingError();
      await scope.#closeTransactionStreamsPreservingError();
      await scope.#settleTransactionBatchPreservingError();
      try {
        await client.query("ROLLBACK");
      } catch (cleanupError) {
        scope.#markTransactionStateUnsafe(cleanupError);
        /* Preserve the original error. */
      }
      try {
        client.release(scope.#transactionLeaseReleaseError());
      } catch {
        /* Preserve the original error. */
      }
      throw error;
    }
    client.release(scope.#transactionLeaseReleaseError());
    return result;
  }

  async #nestedTransaction<T>(fn: (db: PostgresTransaction) => Promise<T>): Promise<T> {
    const client = this.#client!;
    const depth = this.#transactionDepth + 1;
    const savepoint = `typed_sql_${depth}`;
    try {
      await client.query(`SAVEPOINT ${savepoint}`);
    } catch (error) {
      this.#recordTransactionOperationFailure(error);
      throw error;
    }
    const scope = new PostgresDatabaseImplementation(
      this.#pool,
      client,
      this.#parsers,
      false,
      depth,
      this.#prepared,
      this.#transactionState,
    );
    try {
      let result: T;
      try {
        result = await fn(scope);
      } finally {
        scope.#transactionScopeOpen = false;
      }
      if (!scope.#transactionState.valid) {
        throw new Error("The parent PostgreSQL transaction scope ended before its nested transaction completed");
      }
      scope.#throwIfTransactionCannotCommit();
      await scope.#rejectLeakedTransactionWork();
      try {
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        scope.#recordTransactionOperationFailure(error);
        throw error;
      }
      return result;
    } catch (error) {
      await scope.#settleTransactionExecutesPreservingError();
      await scope.#closeTransactionStreamsPreservingError();
      await scope.#settleTransactionBatchPreservingError();
      if (scope.#transactionState.valid) {
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          scope.#recoverTransactionStateAfterSavepoint(depth);
        } catch (cleanupError) {
          scope.#markTransactionStateUnsafe(cleanupError);
          /* Preserve the original callback, query, or release error. */
        }
      }
      throw error;
    }
  }

  #queryConfig<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): PostgresQueryConfig {
    const prepared = this.#prepared.queries.get(query);
    const rendered = prepared?.rendered ?? renderQuery(query, postgresRenderer);
    return {
      ...(prepared === undefined ? {} : { name: prepared.statementName }),
      text: rendered.text,
      values: rendered.values.map(encodeValue),
      types: this.#parsers,
    };
  }

  async #executeBatch<const Queries extends readonly unknown[]>(
    client: PostgresClientLike,
    queries: QueryBatch<Queries>,
  ): Promise<QueryResults<Queries>> {
    const results: (readonly Record<string, unknown>[])[] = [];
    for (const value of queries) {
      this.#assertTransactionScopeOpen();
      const query = value as unknown as Query<unknown, readonly unknown[]>;
      const result = await client.query(this.#queryConfig(query));
      results.push(result.rows);
    }
    return results as QueryResults<Queries>;
  }

  async #rejectLeakedTransactionWork(): Promise<void> {
    const leakedStreams = this.#transactionStreams.size > 0 || this.#transactionState.activeStreams.size > 0;
    const leakedExecutes = this.#transactionExecutes.size > 0 || this.#transactionState.activeExecutes.size > 0;
    const leakedBatch = this.#transactionState.activeBatch !== undefined;
    if (!leakedStreams && !leakedExecutes && !leakedBatch) return;
    await this.#settleTransactionExecutesPreservingError();
    await this.#closeTransactionStreamsPreservingError();
    await this.#settleTransactionBatchPreservingError();
    if (leakedExecutes) {
      throw new Error(
        "A PostgreSQL transaction callback returned before an execute operation completed; await execute before returning",
      );
    }
    if (leakedBatch) {
      throw new Error(
        "A PostgreSQL transaction callback returned before its query batch completed; await the batch before returning",
      );
    }
    throw new Error("A PostgreSQL transaction callback returned before all query streams were completed or closed");
  }

  async #settleTransactionExecutesPreservingError(): Promise<void> {
    const operations = new Set([...this.#transactionExecutes, ...this.#transactionState.activeExecutes]);
    for (const operation of operations) {
      try {
        await operation;
      } catch {
        /* The callback or transaction misuse error remains primary. */
      }
    }
  }

  async #closeTransactionStreamsPreservingError(): Promise<void> {
    const streams = new Set([...this.#transactionStreams, ...this.#transactionState.activeStreams]);
    for (const stream of streams) {
      try {
        await stream.close();
      } catch {
        /* The callback or transaction misuse error remains primary. */
      }
    }
  }

  async #settleTransactionBatchPreservingError(): Promise<void> {
    const operation = this.#transactionState.activeBatch;
    if (operation === undefined) return;
    try {
      await operation;
    } catch {
      /* The callback or transaction misuse error remains primary. */
    }
  }

  #rejectOperationDuringTransactionStream(operation: string): void {
    if (this.#client !== undefined && this.#transactionState.activeStreams.size > 0) {
      throw new Error(
        `Cannot ${operation} while a PostgreSQL transaction query stream is still open; complete or close the stream first`,
      );
    }
  }

  #rejectOperationDuringTransactionBatch(operation: string): void {
    if (this.#client !== undefined && this.#transactionState.activeBatch !== undefined) {
      throw new Error(
        `Cannot ${operation} while a PostgreSQL transaction query batch is still running; await the batch first`,
      );
    }
  }

  #recordTransactionOperationFailure(error: unknown): void {
    if (this.#client === undefined) return;
    if (!this.#transactionOperationFailed) {
      this.#transactionOperationFailed = true;
      this.#transactionOperationError = error;
    }
    this.#markTransactionStateUnsafe(error);
  }

  #markTransactionStateUnsafe(error: unknown): void {
    if (!this.#transactionState.discardLease) {
      this.#transactionState.discardLease = true;
      this.#transactionState.firstDatabaseOperationError = error;
    }
    if (
      !this.#transactionState.unsafe ||
      this.#transactionState.unsafeDepth === undefined ||
      this.#transactionDepth < this.#transactionState.unsafeDepth
    ) {
      this.#transactionState.unsafe = true;
      this.#transactionState.unsafeDepth = this.#transactionDepth;
      this.#transactionState.unsafeError = error;
    }
  }

  #recoverTransactionStateAfterSavepoint(depth: number): void {
    if (this.#transactionState.unsafeDepth === undefined || this.#transactionState.unsafeDepth < depth) return;
    this.#transactionState.unsafe = false;
    this.#transactionState.unsafeDepth = undefined;
    this.#transactionState.unsafeError = undefined;
  }

  #transactionLeaseReleaseError(): Error | boolean | undefined {
    if (!this.#transactionState.discardLease) return undefined;
    return this.#transactionState.firstDatabaseOperationError instanceof Error
      ? this.#transactionState.firstDatabaseOperationError
      : true;
  }

  #throwIfTransactionCannotCommit(): void {
    if (this.#transactionOperationFailed) {
      if (this.#transactionOperationError !== undefined) throw this.#transactionOperationError;
      throw new Error("A PostgreSQL transaction operation failed and the transaction cannot be committed");
    }
    if (this.#transactionState.unsafe) {
      throw new Error("The PostgreSQL transaction connection did not complete recovery and cannot be committed", {
        cause: this.#transactionState.unsafeError,
      });
    }
  }

  #assertTransactionScopeOpen(): void {
    if (this.#client === undefined) return;
    if (!this.#transactionScopeOpen || !this.#transactionState.valid) {
      throw new Error("This PostgreSQL transaction scope has ended and can no longer be used");
    }
    if (this.#transactionOperationFailed) {
      throw new Error("This PostgreSQL transaction scope cannot continue after a database operation failed", {
        cause: this.#transactionOperationError,
      });
    }
    if (this.#transactionState.unsafe) {
      throw new Error("The PostgreSQL transaction cannot continue until its failed operation is rolled back", {
        cause: this.#transactionState.unsafeError,
      });
    }
  }

  async close(): Promise<void> {
    if (this.#client !== undefined) throw new Error("Cannot close a database from inside a transaction");
    if (this.#ownsPool) await this.#pool.end();
  }
}

export function createPostgresDatabase(options: PostgresDatabaseOptions): PostgresDatabase {
  return new PostgresDatabaseImplementation(
    options.pool,
    undefined,
    createPostgresTypeParsers(options.typePolicy ?? defaultPolicy, options.decimal, options.fallbackTypeParsers),
    options.ownsPool ?? false,
    0,
    createPostgresPreparedQueryState(),
  );
}
