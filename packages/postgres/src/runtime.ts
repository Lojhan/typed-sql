import { createHash } from "node:crypto";
import {
  type AdapterCapabilityResolver,
  adapterCapabilities,
  assertExecutionCapabilities,
  createAdapterCapabilityResolver,
  type Database,
  type DatabaseObserver,
  databaseErrorCompletion,
  type ExecutionCapabilities,
  type ExecutionOptions,
  observeQueryStream,
  type Query,
  type QueryBatch,
  type QueryCancelledError,
  QueryCardinalityError,
  type QueryResults,
  type QueryStream,
  renderQuery,
  runControlledExecution,
  type SqlRenderer,
  type StreamOptions,
  startDatabaseObservation,
} from "@typed-sql/core";
import { createPostgresCopyCapability, type PostgresCopyTransport, postgresCopy } from "./bulk.js";
import {
  createPostgresPreparedQueryState,
  type PostgresPreparedQueryFactory,
  type PostgresPreparedQueryState,
  preparePostgresQuery,
} from "./prepared.js";
import { type PostgresCursorLike, PostgresQueryStream, validatePostgresStreamBatchSize } from "./stream.js";
import { defaultPostgresTypePolicy } from "./type-policy.js";
import { POSTGRES_DIALECT_VERSION } from "./version.js";

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

export interface PostgresCopyFromSink {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  abort(error: unknown): Promise<void>;
}

export interface PostgresCopyToSource extends QueryStream<Uint8Array> {
  abort(error: unknown): Promise<void>;
}

export interface PostgresClientLike {
  readonly pipeline?: boolean;
  query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult>;
  openCursor?(config: PostgresQueryConfig): PostgresCursorLike | Promise<PostgresCursorLike>;
  openCopyFrom?(statement: string): Promise<PostgresCopyFromSink>;
  openCopyTo?(statement: string): Promise<PostgresCopyToSource>;
  release(error?: Error | boolean): void;
}

export interface PostgresPoolLike {
  readonly executionCapabilities?: ExecutionCapabilities;
  query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult>;
  ensureCursor?(): Promise<void>;
  ensureCopy?(): Promise<void>;
  connect(): Promise<PostgresClientLike>;
  end(): Promise<void>;
}

export interface PostgresTransaction extends Database<PostgresTransaction> {
  batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
  pipeline<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): PostgresPreparedQueryFactory<Arguments, Row, Params>;
  stream<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, options?: StreamOptions): QueryStream<Row>;
}

export interface PostgresDatabase extends Database<PostgresTransaction> {
  batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
  pipeline<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
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
  readonly observer?: DatabaseObserver;
}

const defaultPolicy: PostgresCodecPolicy = defaultPostgresTypePolicy;
const emptyBatchResults = Object.freeze([]);

interface PostgresObservationState {
  readonly observer: DatabaseObserver | undefined;
  readonly fingerprints: WeakMap<Query<unknown, readonly unknown[]>, string> | undefined;
}

function createPostgresObservationState(observer: DatabaseObserver | undefined): PostgresObservationState {
  return { observer, fingerprints: observer === undefined ? undefined : new WeakMap() };
}

function postgresQueryFingerprint<Row, Params extends readonly unknown[]>(
  state: PostgresObservationState,
  query: Query<Row, Params>,
): string {
  const key = query as unknown as Query<unknown, readonly unknown[]>;
  const cached = state.fingerprints!.get(key);
  if (cached !== undefined) return cached;
  const text = renderQuery(query, postgresRenderer).text;
  const fingerprint = `sha256:${createHash("sha256")
    .update(`postgres\0${POSTGRES_DIALECT_VERSION}\0${text}`)
    .digest("hex")}`;
  state.fingerprints!.set(key, fingerprint);
  return fingerprint;
}

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
  readonly #observation: PostgresObservationState;
  readonly #transactionDepth: number;
  #transactionScopeOpen = true;
  #transactionOperationFailed = false;
  #transactionOperationError: unknown;
  readonly #transactionState: {
    activeBatch: Promise<unknown> | undefined;
    activeCopy: Promise<unknown> | undefined;
    readonly activeExecutes: Set<Promise<unknown>>;
    activePipeline: Promise<unknown> | undefined;
    readonly activeStreams: Set<QueryStream<unknown>>;
    discardLease: boolean;
    leaseReleased: boolean;
    firstDatabaseOperationError: unknown;
    unsafe: boolean;
    unsafeDepth: number | undefined;
    unsafeError: unknown;
    valid: boolean;
  };
  readonly #transactionExecutes = new Set<Promise<unknown>>();
  readonly #transactionStreams = new Set<QueryStream<unknown>>();
  readonly executionCapabilities: ExecutionCapabilities;
  readonly [adapterCapabilities]: AdapterCapabilityResolver;

  constructor(
    pool: PostgresPoolLike,
    client: PostgresClientLike | undefined,
    parsers: PostgresTypeParserSet,
    ownsPool: boolean,
    depth: number,
    prepared: PostgresPreparedQueryState,
    observation: PostgresObservationState,
    transactionState = {
      activeBatch: undefined as Promise<unknown> | undefined,
      activeCopy: undefined as Promise<unknown> | undefined,
      activeExecutes: new Set<Promise<unknown>>(),
      activePipeline: undefined as Promise<unknown> | undefined,
      activeStreams: new Set<QueryStream<unknown>>(),
      discardLease: false,
      leaseReleased: false,
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
    this.#observation = observation;
    this.#transactionState = transactionState;
    this.executionCapabilities = Object.freeze({
      cancellation: pool.executionCapabilities?.cancellation ?? false,
      deadlines: pool.executionCapabilities?.deadlines ?? false,
    });
    const copyTransport: PostgresCopyTransport = {
      copyFrom: (statement, chunks, options) => this.#copyFrom(statement, chunks, options),
      copyTo: (statement, options) => this.#copyTo(statement, options),
    };
    this[adapterCapabilities] = createAdapterCapabilityResolver(
      pool.ensureCopy === undefined ? [] : [[postgresCopy, createPostgresCopyCapability(copyTransport)]],
    );
  }

  async execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> {
    if (this.#observation.observer === undefined) return this.#executeUnobserved(query);
    return this.#observeQuery(query, "many", () => this.#executeUnobserved(query));
  }

  async #executeUnobserved<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> {
    this.#assertTransactionScopeOpen();
    this.#rejectOperationDuringTransactionStream("execute another query");
    this.#rejectOperationDuringTransactionBatch("execute another query");
    this.#rejectOperationDuringTransactionCopy("execute another query");
    this.#rejectOperationDuringTransactionPipeline("execute another query");
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

  async all<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<readonly Row[]> {
    if (this.#observation.observer === undefined) return this.#allUnobserved(query, options);
    return this.#observeQuery(query, "many", () => this.#allUnobserved(query, options));
  }

  async #allUnobserved<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<readonly Row[]> {
    if (options === undefined || (options.signal === undefined && options.deadline === undefined))
      return this.#executeUnobserved(query);
    assertExecutionCapabilities(this.executionCapabilities, options);
    this.#assertTransactionScopeOpen();
    this.#rejectOperationDuringTransactionStream("execute another query");
    this.#rejectOperationDuringTransactionBatch("execute another query");
    this.#rejectOperationDuringTransactionCopy("execute another query");
    this.#rejectOperationDuringTransactionPipeline("execute another query");

    if (options.signal?.aborted || (options.deadline !== undefined && Number(options.deadline) <= Date.now())) {
      return runControlledExecution(
        options,
        async () => [],
        () => undefined,
      ) as Promise<readonly Row[]>;
    }
    if (this.#client === undefined) {
      const client = await this.#pool.connect();
      let discarded = false;
      try {
        return await this.#executeControlledOn<Row, Params>(client, query, options, (error) => {
          client.release(error);
          discarded = true;
        });
      } finally {
        if (!discarded) client.release();
      }
    }

    const client = this.#client;
    const operation = this.#executeControlledOn<Row, Params>(client, query, options, (error) => {
      this.#transactionState.discardLease = true;
      this.#markTransactionStateUnsafe(error);
      try {
        client.release(error);
        this.#transactionState.leaseReleased = true;
      } catch {
        /* The transaction finalizer also owns lease cleanup. */
      }
    });
    this.#transactionExecutes.add(operation);
    this.#transactionState.activeExecutes.add(operation);
    try {
      return await operation;
    } catch (error) {
      this.#recordTransactionOperationFailure(error);
      throw error;
    } finally {
      this.#transactionExecutes.delete(operation);
      this.#transactionState.activeExecutes.delete(operation);
    }
  }

  async #executeControlledOn<Row, Params extends readonly unknown[]>(
    client: PostgresClientLike,
    query: Query<Row, Params>,
    options: ExecutionOptions,
    cancel: (error: QueryCancelledError) => void,
  ): Promise<readonly Row[]> {
    const result = await runControlledExecution(options, () => client.query(this.#queryConfig(query)), cancel);
    return result.rows as readonly Row[];
  }

  async one<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<Row> {
    if (this.#observation.observer === undefined) {
      const rows = await this.#allUnobserved(query, options);
      if (rows.length !== 1) throw new QueryCardinalityError("one", rows.length);
      return rows[0]!;
    }
    const rows = await this.#observeQuery(query, "one", async () => {
      const result = await this.#allUnobserved(query, options);
      if (result.length !== 1) throw new QueryCardinalityError("one", result.length);
      return result;
    });
    return rows[0]!;
  }

  async maybeOne<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<Row | undefined> {
    if (this.#observation.observer === undefined) {
      const rows = await this.#allUnobserved(query, options);
      if (rows.length > 1) throw new QueryCardinalityError("maybeOne", rows.length);
      return rows[0];
    }
    const rows = await this.#observeQuery(query, "maybeOne", async () => {
      const result = await this.#allUnobserved(query, options);
      if (result.length > 1) throw new QueryCardinalityError("maybeOne", result.length);
      return result;
    });
    return rows[0];
  }

  async #observeQuery<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    cardinality: "many" | "one" | "maybeOne",
    operation: () => Promise<readonly Row[]>,
  ): Promise<readonly Row[]> {
    if (this.#observation.observer === undefined) return operation();
    const observation = startDatabaseObservation(this.#observation.observer, {
      kind: "query",
      dialect: "postgres",
      grammarVersion: POSTGRES_DIALECT_VERSION,
      transactionDepth: this.#transactionDepth,
      fingerprint: postgresQueryFingerprint(this.#observation, query),
      cardinality,
      prepared: this.#prepared.queries.has(query),
    });
    if (observation === undefined) return operation();
    try {
      const rows = await observation.run(operation);
      observation.end({ status: "success", rowCount: rows.length });
      return rows;
    } catch (error) {
      observation.end(databaseErrorCompletion(error), error);
      throw error;
    }
  }

  async batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>> {
    if (queries.length === 0) return emptyBatchResults as QueryResults<Queries>;
    if (this.#observation.observer === undefined) return this.#batchUnobserved(queries);
    return this.#observeGroup("batch", queries, () => this.#batchUnobserved(queries));
  }

  async #batchUnobserved<const Queries extends readonly unknown[]>(
    queries: QueryBatch<Queries>,
  ): Promise<QueryResults<Queries>> {
    this.#assertTransactionScopeOpen();
    this.#rejectOperationDuringTransactionStream("execute a query batch");
    this.#rejectOperationDuringTransactionBatch("execute another query batch");
    this.#rejectOperationDuringTransactionCopy("execute a query batch");
    this.#rejectOperationDuringTransactionPipeline("execute a query batch");
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

  async pipeline<const Queries extends readonly unknown[]>(
    queries: QueryBatch<Queries>,
  ): Promise<QueryResults<Queries>> {
    if (queries.length === 0) return emptyBatchResults as QueryResults<Queries>;
    if (this.#observation.observer === undefined) return this.#pipelineUnobserved(queries);
    return this.#observeGroup("pipeline", queries, () => this.#pipelineUnobserved(queries));
  }

  async #pipelineUnobserved<const Queries extends readonly unknown[]>(
    queries: QueryBatch<Queries>,
  ): Promise<QueryResults<Queries>> {
    this.#assertTransactionScopeOpen();
    this.#rejectOperationDuringTransactionStream("execute a query pipeline");
    this.#rejectOperationDuringTransactionBatch("execute a query pipeline");
    this.#rejectOperationDuringTransactionCopy("execute a query pipeline");
    this.#rejectOperationDuringTransactionExecute("execute a query pipeline");
    this.#rejectOperationDuringTransactionPipeline("execute another query pipeline");
    if (queries.length === 0) return emptyBatchResults as QueryResults<Queries>;
    const configs = [...queries].map((value) =>
      this.#queryConfig(value as unknown as Query<unknown, readonly unknown[]>),
    );
    if (this.#client !== undefined) {
      this.#assertPipelineClient(this.#client);
      const operation = this.#executePipeline<Queries>(this.#client, configs);
      this.#transactionState.activePipeline = operation;
      try {
        return await operation;
      } catch (error) {
        this.#recordTransactionOperationFailure(error);
        throw error;
      } finally {
        if (this.#transactionState.activePipeline === operation) this.#transactionState.activePipeline = undefined;
      }
    }

    const client = await this.#pool.connect();
    try {
      this.#assertPipelineClient(client);
    } catch (error) {
      try {
        client.release();
      } catch {
        /* Preserve the missing pipeline-capability error. */
      }
      throw error;
    }
    try {
      const results = await this.#executePipeline<Queries>(client, configs);
      client.release();
      return results as QueryResults<Queries>;
    } catch (error) {
      try {
        client.release(error instanceof Error ? error : true);
      } catch {
        /* Preserve the first pipeline failure. */
      }
      throw error;
    }
  }

  async #observeGroup<const Queries extends readonly unknown[]>(
    kind: "batch" | "pipeline",
    queries: QueryBatch<Queries>,
    operation: () => Promise<QueryResults<Queries>>,
  ): Promise<QueryResults<Queries>> {
    if (this.#observation.observer === undefined) return operation();
    const fingerprints = Object.freeze(
      [...queries].map((query) =>
        postgresQueryFingerprint(this.#observation, query as unknown as Query<unknown, readonly unknown[]>),
      ),
    );
    const observation = startDatabaseObservation(this.#observation.observer, {
      kind,
      dialect: "postgres",
      grammarVersion: POSTGRES_DIALECT_VERSION,
      transactionDepth: this.#transactionDepth,
      fingerprints,
      size: queries.length,
    });
    if (observation === undefined) return operation();
    try {
      const results = await observation.run(operation);
      observation.end({ status: "success" });
      return results;
    } catch (error) {
      observation.end(databaseErrorCompletion(error), error);
      throw error;
    }
  }

  stream<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options: StreamOptions = {},
  ): QueryStream<Row> {
    this.#assertTransactionScopeOpen();
    this.#rejectOperationDuringTransactionStream("start another query stream");
    this.#rejectOperationDuringTransactionBatch("start a query stream");
    this.#rejectOperationDuringTransactionCopy("start a query stream");
    this.#rejectOperationDuringTransactionPipeline("start a query stream");
    const batchSize = validatePostgresStreamBatchSize(options.batchSize);
    const config = this.#queryConfig(query);
    let exposedStream: QueryStream<Row>;
    const stream: QueryStream<Row> = new PostgresQueryStream<Row>({
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
          return { cursor: cursor as PostgresCursorLike<Row>, ...(release === undefined ? {} : { release }) };
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
              this.#rejectOperationDuringTransactionCopy("start a query stream");
              this.#rejectOperationDuringTransactionPipeline("start a query stream");
              this.#transactionState.activeStreams.add(exposedStream as QueryStream<unknown>);
            },
            onClose: () => {
              this.#transactionState.activeStreams.delete(exposedStream as QueryStream<unknown>);
              this.#transactionStreams.delete(exposedStream as QueryStream<unknown>);
            },
            onError: (error: unknown) => this.#recordTransactionOperationFailure(error),
          }),
    });
    exposedStream =
      this.#observation.observer === undefined
        ? stream
        : observeQueryStream(stream, this.#observation.observer, {
            kind: "stream",
            dialect: "postgres",
            grammarVersion: POSTGRES_DIALECT_VERSION,
            transactionDepth: this.#transactionDepth,
            fingerprint: postgresQueryFingerprint(this.#observation, query),
            prepared: this.#prepared.queries.has(query),
          });
    if (this.#client !== undefined) this.#transactionStreams.add(exposedStream as QueryStream<unknown>);
    return exposedStream;
  }

  async #copyFrom(statement: string, chunks: AsyncIterable<Uint8Array>, options: ExecutionOptions): Promise<void> {
    assertExecutionCapabilities(this.executionCapabilities, options);
    this.#assertTransactionScopeOpen();
    this.#rejectOperationDuringTransactionStream("start COPY FROM");
    this.#rejectOperationDuringTransactionBatch("start COPY FROM");
    this.#rejectOperationDuringTransactionCopy("start another COPY operation");
    this.#rejectOperationDuringTransactionExecute("start COPY FROM");
    this.#rejectOperationDuringTransactionPipeline("start COPY FROM");
    await this.#pool.ensureCopy?.();
    const client = this.#client ?? (await this.#pool.connect());
    let sink: PostgresCopyFromSink | undefined;
    const operation = runControlledExecution(
      options,
      async () => {
        if (client.openCopyFrom === undefined) {
          throw new Error(
            "PostgreSQL COPY requires the application-owned pg-copy-streams package. Install it with: pnpm add pg-copy-streams",
          );
        }
        sink = await client.openCopyFrom(statement);
        try {
          for await (const chunk of chunks) await sink.write(chunk);
          await sink.finish();
        } catch (error) {
          try {
            await sink.abort(error);
          } catch {
            /* Preserve the producer or database failure. */
          }
          throw error;
        }
      },
      (error) => {
        void sink?.abort(error).catch(() => undefined);
      },
    );
    if (this.#client !== undefined) this.#transactionState.activeCopy = operation;
    try {
      await operation;
      if (this.#client === undefined) client.release();
    } catch (error) {
      this.#recordTransactionOperationFailure(error);
      if (this.#client === undefined) {
        try {
          client.release(error instanceof Error ? error : true);
        } catch {
          /* Preserve the COPY failure. */
        }
      }
      throw error;
    } finally {
      if (this.#transactionState.activeCopy === operation) this.#transactionState.activeCopy = undefined;
    }
  }

  #copyTo(statement: string, options: ExecutionOptions): QueryStream<Uint8Array> {
    assertExecutionCapabilities(this.executionCapabilities, options);
    this.#assertTransactionScopeOpen();
    this.#rejectOperationDuringTransactionStream("start COPY TO");
    this.#rejectOperationDuringTransactionBatch("start COPY TO");
    this.#rejectOperationDuringTransactionCopy("start COPY TO");
    this.#rejectOperationDuringTransactionPipeline("start COPY TO");
    let exposedStream: QueryStream<Uint8Array>;
    const stream = new PostgresQueryStream<Uint8Array>({
      batchSize: 1,
      start: async () => {
        await this.#pool.ensureCopy?.();
        const client = this.#client ?? (await this.#pool.connect());
        const release =
          this.#client === undefined
            ? (cleanupError?: unknown): void =>
                client.release(
                  cleanupError === undefined ? undefined : cleanupError instanceof Error ? cleanupError : true,
                )
            : undefined;
        if (client.openCopyTo === undefined) {
          try {
            release?.();
          } catch {
            /* The missing optional dependency remains primary. */
          }
          throw new Error(
            "PostgreSQL COPY requires the application-owned pg-copy-streams package. Install it with: pnpm add pg-copy-streams",
          );
        }
        try {
          const source = await client.openCopyTo(statement);
          return {
            cursor: {
              async read(): Promise<readonly Uint8Array[]> {
                const result = await runControlledExecution(
                  options,
                  () => source.next(),
                  (error) => {
                    void source.abort(error).catch(() => undefined);
                  },
                );
                return result.done === true ? [] : [result.value];
              },
              close: () => source.close(),
            },
            ...(release === undefined ? {} : { release }),
          };
        } catch (error) {
          this.#recordTransactionOperationFailure(error);
          try {
            release?.(error);
          } catch {
            /* Preserve source creation or optional-dependency failures. */
          }
          throw error;
        }
      },
      ...(this.#client === undefined
        ? {}
        : {
            onStart: () => {
              this.#assertTransactionScopeOpen();
              this.#rejectOperationDuringTransactionStream("start COPY TO");
              this.#rejectOperationDuringTransactionBatch("start COPY TO");
              this.#rejectOperationDuringTransactionCopy("start COPY TO");
              this.#rejectOperationDuringTransactionPipeline("start COPY TO");
              this.#transactionState.activeStreams.add(exposedStream as QueryStream<unknown>);
            },
            onClose: () => {
              this.#transactionState.activeStreams.delete(exposedStream as QueryStream<unknown>);
              this.#transactionStreams.delete(exposedStream as QueryStream<unknown>);
            },
            onError: (error: unknown) => this.#recordTransactionOperationFailure(error),
          }),
    });
    exposedStream = stream;
    if (this.#client !== undefined) this.#transactionStreams.add(exposedStream as QueryStream<unknown>);
    return exposedStream;
  }

  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): PostgresPreparedQueryFactory<Arguments, Row, Params> {
    this.#assertTransactionScopeOpen();
    return preparePostgresQuery(this.#prepared, postgresRenderer, statementName, factory);
  }

  async transaction<T>(fn: (db: PostgresTransaction) => Promise<T>): Promise<T> {
    if (this.#observation.observer === undefined) return this.#transactionUnobserved(fn);
    const observation = startDatabaseObservation(this.#observation.observer, {
      kind: "transaction",
      dialect: "postgres",
      grammarVersion: POSTGRES_DIALECT_VERSION,
      transactionDepth: this.#transactionDepth + 1,
    });
    if (observation === undefined) return this.#transactionUnobserved(fn);
    try {
      const result = await observation.run(() => this.#transactionUnobserved(fn));
      observation.end({ status: "success" });
      return result;
    } catch (error) {
      observation.end(databaseErrorCompletion(error), error);
      throw error;
    }
  }

  async #transactionUnobserved<T>(fn: (db: PostgresTransaction) => Promise<T>): Promise<T> {
    this.#assertTransactionScopeOpen();
    this.#rejectOperationDuringTransactionStream("start a nested transaction");
    this.#rejectOperationDuringTransactionBatch("start a nested transaction");
    this.#rejectOperationDuringTransactionCopy("start a nested transaction");
    this.#rejectOperationDuringTransactionPipeline("start a nested transaction");
    if (this.#client !== undefined) return this.#nestedTransaction(fn);
    const client = await this.#pool.connect();
    const scope = new PostgresDatabaseImplementation(
      this.#pool,
      client,
      this.#parsers,
      false,
      1,
      this.#prepared,
      this.#observation,
      {
        activeBatch: undefined,
        activeCopy: undefined,
        activeExecutes: new Set(),
        activePipeline: undefined,
        activeStreams: new Set(),
        discardLease: false,
        leaseReleased: false,
        firstDatabaseOperationError: undefined,
        unsafe: false,
        unsafeDepth: undefined,
        unsafeError: undefined,
        valid: true,
      },
    );
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
      await scope.#settleTransactionPipelinePreservingError();
      await scope.#settleTransactionBatchPreservingError();
      await scope.#settleTransactionCopyPreservingError();
      if (!scope.#transactionState.leaseReleased) {
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
      this.#observation,
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
      await scope.#settleTransactionPipelinePreservingError();
      await scope.#settleTransactionBatchPreservingError();
      await scope.#settleTransactionCopyPreservingError();
      if (scope.#transactionState.valid && !scope.#transactionState.leaseReleased) {
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

  async #executePipeline<const Queries extends readonly unknown[]>(
    client: PostgresClientLike,
    configs: readonly PostgresQueryConfig[],
  ): Promise<QueryResults<Queries>> {
    const operations: Promise<PostgresQueryResult>[] = [];
    let dispatchFailed = false;
    let dispatchError: unknown;
    for (const config of configs) {
      try {
        operations.push(client.query(config));
      } catch (error) {
        dispatchFailed = true;
        dispatchError = error;
        break;
      }
    }
    const settlements = await Promise.allSettled(operations);
    if (dispatchFailed) throw dispatchError;
    const results: (readonly Record<string, unknown>[])[] = [];
    for (const settlement of settlements) {
      if (settlement.status === "rejected") throw settlement.reason;
      results.push(settlement.value.rows);
    }
    return results as QueryResults<Queries>;
  }

  #assertPipelineClient(client: PostgresClientLike): void {
    if (client.pipeline !== true) {
      throw new Error(
        "PostgreSQL query pipelining requires pg 8.23.0 or newer and pipeline mode. Create the application-owned Pool with { pipeline: true }",
      );
    }
  }

  async #rejectLeakedTransactionWork(): Promise<void> {
    const leakedStreams = this.#transactionStreams.size > 0 || this.#transactionState.activeStreams.size > 0;
    const leakedExecutes = this.#transactionExecutes.size > 0 || this.#transactionState.activeExecutes.size > 0;
    const leakedPipeline = this.#transactionState.activePipeline !== undefined;
    const leakedBatch = this.#transactionState.activeBatch !== undefined;
    const leakedCopy = this.#transactionState.activeCopy !== undefined;
    if (!leakedStreams && !leakedExecutes && !leakedPipeline && !leakedBatch && !leakedCopy) return;
    await this.#settleTransactionExecutesPreservingError();
    await this.#closeTransactionStreamsPreservingError();
    await this.#settleTransactionPipelinePreservingError();
    await this.#settleTransactionBatchPreservingError();
    await this.#settleTransactionCopyPreservingError();
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
    if (leakedPipeline) {
      throw new Error(
        "A PostgreSQL transaction callback returned before its query pipeline completed; await the pipeline before returning",
      );
    }
    if (leakedCopy) {
      throw new Error(
        "A PostgreSQL transaction callback returned before its COPY operation completed; await COPY before returning",
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

  async #settleTransactionPipelinePreservingError(): Promise<void> {
    const operation = this.#transactionState.activePipeline;
    if (operation === undefined) return;
    try {
      await operation;
    } catch {
      /* The callback or transaction misuse error remains primary. */
    }
  }

  async #settleTransactionCopyPreservingError(): Promise<void> {
    const operation = this.#transactionState.activeCopy;
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

  #rejectOperationDuringTransactionCopy(operation: string): void {
    if (this.#client !== undefined && this.#transactionState.activeCopy !== undefined) {
      throw new Error(
        `Cannot ${operation} while a PostgreSQL transaction COPY operation is still running; await COPY first`,
      );
    }
  }

  #rejectOperationDuringTransactionExecute(operation: string): void {
    if (this.#client !== undefined && this.#transactionState.activeExecutes.size > 0) {
      throw new Error(
        `Cannot ${operation} while a PostgreSQL transaction execute operation is still running; await execute first`,
      );
    }
  }

  #rejectOperationDuringTransactionPipeline(operation: string): void {
    if (this.#client !== undefined && this.#transactionState.activePipeline !== undefined) {
      throw new Error(
        `Cannot ${operation} while a PostgreSQL transaction query pipeline is still running; await the pipeline first`,
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
    createPostgresObservationState(options.observer),
  );
}
