import { createHash } from "node:crypto";
import type { DialectServerEvidence } from "@typed-sql/core";
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
  hasQueryResultValidator,
  observeQueryStream,
  type Query,
  type QueryBatch,
  type QueryCancelledError,
  QueryCardinalityError,
  type QueryResults,
  type QueryStream,
  queryResultValidationSource,
  renderQuery,
  runControlledExecution,
  type SqlRenderer,
  type StreamOptions,
  startDatabaseObservation,
  UnsupportedExecutionCapabilityError,
  validateQueryResultRows,
  validateQueryResultStream,
} from "@typed-sql/core";
import type { SchemaSnapshotV2 } from "@typed-sql/schema";
import { createMySqlBulkCapability, type MySqlBulkTransport, mysqlBulk } from "./bulk.js";
import { assertMySqlServerEvidence } from "./capabilities.js";
import {
  decodeMySqlRows,
  encodeMySqlValue,
  MySqlDecoderPlanCache,
  type MySqlFieldLike,
  type MySqlRuntimeTypePolicy,
} from "./decoding.js";
import {
  createMySqlPreparedQueryState,
  type MySqlPreparedQueryFactory,
  type MySqlPreparedQueryState,
  prepareMySqlQuery,
} from "./prepared.js";
import { createMySqlQueryStream, type MySqlStreamingConnection, validateMySqlStreamBatchSize } from "./stream.js";
import { defaultMySqlTypePolicy, type MySqlTypePolicy } from "./type-policy.js";
import { MYSQL_DIALECT_VERSION } from "./version.js";

export type { MySqlFieldLike } from "./decoding.js";
export type { MySqlPreparedQueryFactory } from "./prepared.js";
export type { MySqlProtocolStream } from "./stream.js";

export interface MySqlExecutionResult {
  readonly rows: readonly Record<string, unknown>[] | Record<string, unknown>;
  readonly fields?: readonly MySqlFieldLike[];
  readonly warningCount?: number;
}

export interface MySqlConnectionLike extends MySqlStreamingConnection {
  execute(sql: string, values?: readonly unknown[]): Promise<MySqlExecutionResult>;
  query(sql: string): Promise<MySqlExecutionResult>;
  loadData?(statement: string, chunks: AsyncIterable<Uint8Array>): Promise<void>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  readServerEvidence?(): Promise<DialectServerEvidence>;
  readWarningCount?(): Promise<number>;
  destroy?(): void;
  release(): void;
}

export interface MySqlPoolLike {
  readonly executionCapabilities?: ExecutionCapabilities;
  readonly bulkLoad?: boolean;
  execute(sql: string, values?: readonly unknown[]): Promise<MySqlExecutionResult>;
  getConnection(): Promise<MySqlConnectionLike>;
  end(): Promise<void>;
}

export interface MySqlTransaction extends Database<MySqlTransaction> {
  batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
  stream<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, options?: StreamOptions): QueryStream<Row>;
  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): MySqlPreparedQueryFactory<Arguments, Row, Params>;
}

export interface MySqlDatabase extends Database<MySqlTransaction> {
  batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
  stream<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, options?: StreamOptions): QueryStream<Row>;
  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): MySqlPreparedQueryFactory<Arguments, Row, Params>;
  close(): Promise<void>;
}

export interface MySqlDatabaseOptions {
  readonly pool: MySqlPoolLike;
  readonly ownsPool?: boolean;
  readonly typePolicy?: Pick<MySqlTypePolicy, "bigint" | "decimal" | "date" | "json" | "tinyint1">;
  readonly decimal?: (value: string) => unknown;
  readonly observer?: DatabaseObserver;
  /** Snapshot evidence that every physical connection must match before application SQL is sent. */
  readonly compatibilitySnapshot?: SchemaSnapshotV2 & { readonly dialect: "mysql" };
  readonly decoderPlanCacheCapacity?: number;
  readonly preparedStatementLimit?: number;
  /** Maximum rendered cardinalities cached by each logical prepared factory. Defaults to 32. */
  readonly preparedCardinalityVariantLimit?: number;
  readonly onWarning?: (warning: MySqlExecutionWarning) => void;
  readonly rejectWarnings?: boolean;
}

export interface MySqlExecutionWarning {
  readonly count: number;
  readonly fingerprint: string;
}

export class MySqlRuntimeCompatibilityError extends Error {
  readonly code = "TSQL_MYSQL_INCOMPATIBLE_RUNTIME";
  readonly differences: readonly string[];

  constructor(message: string, differences: readonly string[] = []) {
    super(message);
    this.name = "MySqlRuntimeCompatibilityError";
    this.differences = Object.freeze([...differences]);
  }
}

export class MySqlWarningError extends Error {
  readonly code = "TSQL_MYSQL_WARNING";
  readonly warning: MySqlExecutionWarning;

  constructor(warning: MySqlExecutionWarning) {
    super(`MySQL execution produced ${warning.count} warning${warning.count === 1 ? "" : "s"}`);
    this.name = "MySqlWarningError";
    this.warning = warning;
  }
}

export class MySqlWarningInspectionError extends Error {
  readonly code = "TSQL_MYSQL_WARNING_UNAVAILABLE";

  constructor() {
    super("The MySQL adapter cannot inspect execution warnings required by the configured warning policy");
    this.name = "MySqlWarningInspectionError";
  }
}

const defaultRuntimeTypePolicy: MySqlRuntimeTypePolicy = defaultMySqlTypePolicy;
const emptyBatchResults = Object.freeze([]);

interface MySqlObservationState {
  readonly observer: DatabaseObserver | undefined;
  readonly fingerprints: WeakMap<Query<unknown, readonly unknown[]>, string> | undefined;
}

function createMySqlObservationState(observer: DatabaseObserver | undefined): MySqlObservationState {
  return { observer, fingerprints: observer === undefined ? undefined : new WeakMap() };
}

function mysqlQueryFingerprint<Row, Params extends readonly unknown[]>(
  state: MySqlObservationState,
  query: Query<Row, Params>,
): string {
  const key = query as unknown as Query<unknown, readonly unknown[]>;
  const cached = state.fingerprints?.get(key);
  if (cached !== undefined) return cached;
  const text = renderQuery(query, mysqlRenderer).text;
  const fingerprint = mysqlTextFingerprint(text);
  state.fingerprints?.set(key, fingerprint);
  return fingerprint;
}

function mysqlTextFingerprint(text: string): string {
  return `sha256:${createHash("sha256").update(`mysql\0${MYSQL_DIALECT_VERSION}\0${text}`).digest("hex")}`;
}

interface MySqlRuntimeSafetyState {
  readonly expectedServer: DialectServerEvidence | undefined;
  readonly onWarning: ((warning: MySqlExecutionWarning) => void) | undefined;
  readonly rejectWarnings: boolean;
}

function serverDifferences(expected: DialectServerEvidence, actual: DialectServerEvidence): readonly string[] {
  const differences: string[] = [];
  if (expected.product !== actual.product) differences.push("product");
  if (expected.versionKey !== actual.versionKey) differences.push("versionKey");
  const settingKeys = [...new Set([...Object.keys(expected.settings), ...Object.keys(actual.settings)])].sort();
  for (const key of settingKeys) {
    if (expected.settings[key] !== actual.settings[key]) differences.push(`settings.${key}`);
  }
  return Object.freeze(differences);
}

export const mysqlRenderer: SqlRenderer = Object.freeze({
  placeholder: () => "?",
  quoteIdentifier: (identifier: string) => `\`${identifier.replaceAll("`", "``")}\``,
});

interface MySqlTransactionConnectionState {
  active: QueryStream<unknown> | undefined;
  batch: MySqlConnectionOperation | undefined;
  bulk: MySqlConnectionOperation | undefined;
  execute: MySqlConnectionOperation | undefined;
  discarded: boolean;
  usable: boolean;
}

interface MySqlConnectionOperation {
  readonly completion: Promise<void>;
  finish(): void;
}

function discardFailedRecovery(connection: MySqlConnectionLike, state?: MySqlTransactionConnectionState): void {
  if (state?.discarded === true) return;
  if (state !== undefined) {
    state.usable = false;
    state.discarded = true;
  }
  try {
    connection.destroy?.();
  } catch {
    // Preserve the initiating failure. Never release a lease whose recovery failed,
    // including host adapters that cannot destroy it or whose destroy hook throws.
  }
}

function createMySqlConnectionOperation(): MySqlConnectionOperation {
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { completion, finish };
}

class MySqlDatabaseImplementation implements MySqlDatabase {
  readonly #pool: MySqlPoolLike;
  readonly #connection: MySqlConnectionLike | undefined;
  readonly #ownsPool: boolean;
  readonly #depth: number;
  readonly #prepared: MySqlPreparedQueryState;
  readonly #observation: MySqlObservationState;
  readonly #safety: MySqlRuntimeSafetyState;
  readonly #decoderPlans: MySqlDecoderPlanCache;
  readonly #executes: Set<MySqlConnectionOperation> | undefined;
  readonly #streams: Set<QueryStream<unknown>> | undefined;
  readonly #transactionState: MySqlTransactionConnectionState | undefined;
  #scopeOpen = true;
  readonly executionCapabilities: ExecutionCapabilities;
  readonly [adapterCapabilities]: AdapterCapabilityResolver;

  constructor(
    pool: MySqlPoolLike,
    connection: MySqlConnectionLike | undefined,
    ownsPool: boolean,
    depth: number,
    prepared: MySqlPreparedQueryState,
    decoderPlans: MySqlDecoderPlanCache,
    observation: MySqlObservationState,
    safety: MySqlRuntimeSafetyState,
    transactionState?: MySqlTransactionConnectionState,
  ) {
    this.#pool = pool;
    this.#connection = connection;
    this.#ownsPool = ownsPool;
    this.#depth = depth;
    this.#prepared = prepared;
    this.#decoderPlans = decoderPlans;
    this.#observation = observation;
    this.#safety = safety;
    this.#executes = connection === undefined ? undefined : new Set();
    this.#streams = connection === undefined ? undefined : new Set();
    this.#transactionState = transactionState;
    this.executionCapabilities = Object.freeze({
      cancellation: pool.executionCapabilities?.cancellation ?? false,
      deadlines: pool.executionCapabilities?.deadlines ?? false,
    });
    const bulkTransport: MySqlBulkTransport = {
      loadData: (statement, chunks, options) => this.#loadData(statement, chunks, options),
    };
    this[adapterCapabilities] = createAdapterCapabilityResolver(
      pool.bulkLoad === true ? [[mysqlBulk, createMySqlBulkCapability(bulkTransport)]] : [],
    );
  }

  async execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> {
    if (this.#observation.observer === undefined) {
      return this.#validateRows(query, await this.#executeUnobserved(query));
    }
    return this.#observeQuery(query, "many", async () =>
      this.#validateRows(query, await this.#executeUnobserved(query)),
    );
  }

  async #executeUnobserved<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> {
    this.#assertScopeOpen();
    this.#assertConnectionAvailable("execute a query");
    if (
      this.#connection === undefined &&
      this.#safety.expectedServer === undefined &&
      this.#safety.onWarning === undefined &&
      !this.#safety.rejectWarnings
    )
      return this.#executeOn(this.#pool, query);
    if (this.#connection === undefined) {
      const connection = await this.#pool.getConnection();
      let rows: readonly Row[];
      try {
        rows = await this.#executeOn(connection, query);
      } catch (error) {
        try {
          connection.release();
        } catch {
          /* Preserve the compatibility or execution failure. */
        }
        throw error;
      }
      connection.release();
      return rows;
    }
    const operation = createMySqlConnectionOperation();
    this.#executes!.add(operation);
    this.#transactionState!.execute = operation;
    try {
      return await this.#executeOn(this.#connection, query);
    } finally {
      this.#executes!.delete(operation);
      if (this.#transactionState?.execute === operation) this.#transactionState.execute = undefined;
      operation.finish();
    }
  }

  async all<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<readonly Row[]> {
    if (this.#observation.observer === undefined) {
      return this.#validateRows(query, await this.#allUnobserved(query, options));
    }
    return this.#observeQuery(query, "many", async () =>
      this.#validateRows(query, await this.#allUnobserved(query, options)),
    );
  }

  async #allUnobserved<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<readonly Row[]> {
    if (options === undefined || (options.signal === undefined && options.deadline === undefined))
      return this.#executeUnobserved(query);
    assertExecutionCapabilities(this.executionCapabilities, options);
    this.#assertScopeOpen();
    this.#assertConnectionAvailable("execute a query");
    if (options.signal?.aborted || (options.deadline !== undefined && Number(options.deadline) <= Date.now())) {
      return runControlledExecution(
        options,
        async () => [],
        () => undefined,
      ) as Promise<readonly Row[]>;
    }

    if (this.#connection === undefined) {
      const connection = await this.#pool.getConnection();
      if (connection.destroy === undefined) {
        connection.release();
        throw new UnsupportedExecutionCapabilityError(options.signal === undefined ? "deadlines" : "cancellation");
      }
      let discarded = false;
      try {
        return await this.#executeControlledOn<Row, Params>(connection, query, options, () => {
          connection.destroy!();
          discarded = true;
        });
      } finally {
        if (!discarded) connection.release();
      }
    }

    const connection = this.#connection;
    if (connection.destroy === undefined) {
      throw new UnsupportedExecutionCapabilityError(options.signal === undefined ? "deadlines" : "cancellation");
    }
    const operationState = createMySqlConnectionOperation();
    this.#executes!.add(operationState);
    this.#transactionState!.execute = operationState;
    try {
      return await this.#executeControlledOn<Row, Params>(connection, query, options, () => {
        this.#transactionState!.usable = false;
        connection.destroy!();
        this.#transactionState!.discarded = true;
      });
    } finally {
      this.#executes!.delete(operationState);
      if (this.#transactionState?.execute === operationState) this.#transactionState.execute = undefined;
      operationState.finish();
    }
  }

  async #executeControlledOn<Row, Params extends readonly unknown[]>(
    connection: MySqlConnectionLike,
    query: Query<Row, Params>,
    options: ExecutionOptions,
    cancel: (error: QueryCancelledError) => void,
  ): Promise<readonly Row[]> {
    return runControlledExecution(options, () => this.#executeOn(connection, query), cancel);
  }

  async one<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<Row> {
    if (this.#observation.observer === undefined) {
      const rows = await this.#validateRows(query, await this.#allUnobserved(query, options));
      if (rows.length !== 1) throw new QueryCardinalityError("one", rows.length);
      return rows[0]!;
    }
    const rows = await this.#observeQuery(query, "one", async () => {
      const result = await this.#validateRows(query, await this.#allUnobserved(query, options));
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
      const rows = await this.#validateRows(query, await this.#allUnobserved(query, options));
      if (rows.length > 1) throw new QueryCardinalityError("maybeOne", rows.length);
      return rows[0];
    }
    const rows = await this.#observeQuery(query, "maybeOne", async () => {
      const result = await this.#validateRows(query, await this.#allUnobserved(query, options));
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
      dialect: "mysql",
      grammarVersion: MYSQL_DIALECT_VERSION,
      transactionDepth: this.#depth,
      fingerprint: mysqlQueryFingerprint(this.#observation, query),
      cardinality,
      prepared: this.#prepared.queries.has(queryResultValidationSource(query)),
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

  async #executeOn<Row, Params extends readonly unknown[]>(
    executor: Pick<MySqlConnectionLike, "execute" | "readServerEvidence" | "readWarningCount">,
    query: Query<Row, Params>,
  ): Promise<readonly Row[]> {
    if (this.#safety.expectedServer !== undefined) await this.#verifyConnection(executor);
    const prepared = this.#prepared.queries.get(queryResultValidationSource(query));
    const rendered = prepared?.rendered ?? renderQuery(query, mysqlRenderer);
    if (
      (this.#safety.onWarning !== undefined || this.#safety.rejectWarnings) &&
      executor.readWarningCount === undefined
    ) {
      throw new MySqlWarningInspectionError();
    }
    const result = await executor.execute(rendered.text, rendered.values.map(encodeMySqlValue));
    if (result.warningCount !== undefined && (!Number.isSafeInteger(result.warningCount) || result.warningCount < 0)) {
      throw new MySqlWarningInspectionError();
    }
    let warningCount = result.warningCount ?? 0;
    if (result.warningCount === undefined && (this.#safety.onWarning !== undefined || this.#safety.rejectWarnings)) {
      try {
        warningCount = await executor.readWarningCount!();
      } catch {
        throw new MySqlWarningInspectionError();
      }
    }
    if (warningCount > 0) {
      const warning = Object.freeze({ count: warningCount, fingerprint: mysqlTextFingerprint(rendered.text) });
      this.#safety.onWarning?.(warning);
      if (this.#safety.rejectWarnings) throw new MySqlWarningError(warning);
    }
    if (!Array.isArray(result.rows)) return [];
    const decoders = this.#decoderPlans.get(result.fields ?? []);
    return decodeMySqlRows(result.rows, decoders) as unknown as readonly Row[];
  }

  async #verifyConnection(connection: Pick<MySqlConnectionLike, "readServerEvidence">): Promise<void> {
    const expected = this.#safety.expectedServer;
    if (expected === undefined) return;
    if (connection.readServerEvidence === undefined) {
      throw new MySqlRuntimeCompatibilityError(
        "The MySQL adapter cannot prove runtime compatibility for the supplied snapshot",
        ["adapter.serverEvidence"],
      );
    }
    let actual: DialectServerEvidence;
    try {
      actual = await connection.readServerEvidence();
      assertMySqlServerEvidence(actual);
    } catch {
      throw new MySqlRuntimeCompatibilityError(
        "The MySQL adapter could not prove runtime compatibility for the supplied snapshot",
        ["adapter.serverEvidence"],
      );
    }
    const differences = serverDifferences(expected, actual);
    if (differences.length > 0) {
      throw new MySqlRuntimeCompatibilityError(
        `MySQL runtime evidence differs from the compatibility snapshot (${differences.join(", ")})`,
        differences,
      );
    }
  }

  async batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>> {
    if (queries.length === 0) return emptyBatchResults as QueryResults<Queries>;
    if (this.#observation.observer === undefined) {
      return this.#validateBatch(queries, await this.#batchUnobserved(queries));
    }
    return this.#observeBatch(queries, async () => this.#validateBatch(queries, await this.#batchUnobserved(queries)));
  }

  async #batchUnobserved<const Queries extends readonly unknown[]>(
    queries: QueryBatch<Queries>,
  ): Promise<QueryResults<Queries>> {
    this.#assertScopeOpen();
    this.#assertConnectionAvailable("execute a batch");
    if (queries.length === 0) return emptyBatchResults as QueryResults<Queries>;
    const orderedQueries = [...queries] as unknown as QueryBatch<Queries>;

    if (this.#connection !== undefined) {
      const operation = createMySqlConnectionOperation();
      this.#transactionState!.batch = operation;
      try {
        return await this.#executeBatchOn(this.#connection, orderedQueries, () =>
          this.#assertBatchCanContinue(operation),
        );
      } finally {
        if (this.#transactionState?.batch === operation) this.#transactionState.batch = undefined;
        operation.finish();
      }
    }
    const connection = await this.#pool.getConnection();
    let results: QueryResults<Queries>;
    try {
      results = await this.#executeBatchOn(connection, orderedQueries);
    } catch (error) {
      try {
        connection.release();
      } catch {
        /* Preserve the batch execution failure. */
      }
      throw error;
    }
    connection.release();
    return results;
  }

  async #observeBatch<const Queries extends readonly unknown[]>(
    queries: QueryBatch<Queries>,
    operation: () => Promise<QueryResults<Queries>>,
  ): Promise<QueryResults<Queries>> {
    if (this.#observation.observer === undefined) return operation();
    const fingerprints = Object.freeze(
      [...queries].map((query) =>
        mysqlQueryFingerprint(this.#observation, query as unknown as Query<unknown, readonly unknown[]>),
      ),
    );
    const observation = startDatabaseObservation(this.#observation.observer, {
      kind: "batch",
      dialect: "mysql",
      grammarVersion: MYSQL_DIALECT_VERSION,
      transactionDepth: this.#depth,
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

  async #executeBatchOn<const Queries extends readonly unknown[]>(
    connection: MySqlConnectionLike,
    queries: QueryBatch<Queries>,
    beforeEach?: () => void,
  ): Promise<QueryResults<Queries>> {
    const results: unknown[] = [];
    for (const query of queries) {
      beforeEach?.();
      results.push(await this.#executeOn(connection, query));
    }
    return results as QueryResults<Queries>;
  }

  stream<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options: StreamOptions = {},
  ): QueryStream<Row> {
    this.#assertScopeOpen();
    const prepared = this.#prepared.queries.get(queryResultValidationSource(query));
    const rendered = prepared?.rendered ?? renderQuery(query, mysqlRenderer);
    const batchSize = validateMySqlStreamBatchSize(options.batchSize);
    let exposedStream: QueryStream<Row>;
    const queryStream: QueryStream<Row> = createMySqlQueryStream<Row>({
      openConnection: async () => {
        if (this.#connection !== undefined) {
          this.#assertScopeOpen();
          this.#assertConnectionAvailable("start another query stream");
          await this.#verifyConnection(this.#connection);
          this.#transactionState!.active = exposedStream as QueryStream<unknown>;
          return { connection: this.#connection, release: false };
        }
        const connection = await this.#pool.getConnection();
        try {
          await this.#verifyConnection(connection);
          return { connection, release: true };
        } catch (error) {
          try {
            connection.release();
          } catch {
            /* Preserve the compatibility failure. */
          }
          throw error;
        }
      },
      text: rendered.text,
      values: rendered.values.map(encodeMySqlValue),
      batchSize,
      decoderPlans: this.#decoderPlans,
      onClose: () => {
        this.#streams?.delete(exposedStream as QueryStream<unknown>);
        if (this.#transactionState?.active === exposedStream) this.#transactionState.active = undefined;
      },
    });
    const validatedStream = hasQueryResultValidator(query)
      ? validateQueryResultStream(query, queryStream, mysqlQueryFingerprint(this.#observation, query))
      : queryStream;
    exposedStream =
      this.#observation.observer === undefined
        ? validatedStream
        : observeQueryStream(validatedStream, this.#observation.observer, {
            kind: "stream",
            dialect: "mysql",
            grammarVersion: MYSQL_DIALECT_VERSION,
            transactionDepth: this.#depth,
            fingerprint: mysqlQueryFingerprint(this.#observation, query),
            prepared: prepared !== undefined,
          });
    this.#streams?.add(exposedStream as QueryStream<unknown>);
    return exposedStream;
  }

  async #validateRows<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    rows: readonly unknown[],
  ): Promise<readonly Row[]> {
    if (!hasQueryResultValidator(query)) return rows as readonly Row[];
    return validateQueryResultRows(query, rows, mysqlQueryFingerprint(this.#observation, query));
  }

  async #validateBatch<const Queries extends readonly unknown[]>(
    queries: QueryBatch<Queries>,
    results: QueryResults<Queries>,
  ): Promise<QueryResults<Queries>> {
    let validated: unknown[] | undefined;
    const queryList = queries as unknown as readonly Query<unknown, readonly unknown[]>[];
    const resultList = results as readonly (readonly unknown[])[];
    for (let index = 0; index < queryList.length; index += 1) {
      const query = queryList[index]!;
      if (!hasQueryResultValidator(query)) continue;
      validated ??= [...resultList];
      validated[index] = await validateQueryResultRows(
        query,
        resultList[index]!,
        mysqlQueryFingerprint(this.#observation, query),
      );
    }
    return (validated ?? results) as QueryResults<Queries>;
  }

  async #loadData(statement: string, chunks: AsyncIterable<Uint8Array>, options: ExecutionOptions): Promise<void> {
    assertExecutionCapabilities(this.executionCapabilities, options);
    this.#assertScopeOpen();
    this.#assertConnectionAvailable("start LOAD DATA");
    const connection = this.#connection ?? (await this.#pool.getConnection());
    if (connection.loadData === undefined) {
      if (this.#connection === undefined) connection.release();
      throw new Error(
        "MySQL LOAD DATA requires an adapter with an application-owned local infile stream implementation",
      );
    }
    const state = createMySqlConnectionOperation();
    if (this.#connection !== undefined) this.#transactionState!.bulk = state;
    let discarded = false;
    const discard = (): void => {
      if (discarded || connection.destroy === undefined) return;
      discarded = true;
      connection.destroy();
      if (this.#transactionState !== undefined) {
        this.#transactionState.usable = false;
        this.#transactionState.discarded = true;
      }
    };
    try {
      await this.#verifyConnection(connection);
      await runControlledExecution(options, () => connection.loadData!(statement, chunks), discard);
      if (this.#connection === undefined) connection.release();
    } catch (error) {
      discard();
      if (!discarded && this.#connection === undefined) connection.release();
      throw error;
    } finally {
      if (this.#transactionState?.bulk === state) this.#transactionState.bulk = undefined;
      state.finish();
    }
  }

  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): MySqlPreparedQueryFactory<Arguments, Row, Params> {
    this.#assertScopeOpen();
    return prepareMySqlQuery(this.#prepared, mysqlRenderer, statementName, factory);
  }

  async transaction<T>(fn: (database: MySqlTransaction) => Promise<T>): Promise<T> {
    if (this.#observation.observer === undefined) return this.#transactionUnobserved(fn);
    const observation = startDatabaseObservation(this.#observation.observer, {
      kind: "transaction",
      dialect: "mysql",
      grammarVersion: MYSQL_DIALECT_VERSION,
      transactionDepth: this.#depth + 1,
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

  async #transactionUnobserved<T>(fn: (database: MySqlTransaction) => Promise<T>): Promise<T> {
    this.#assertScopeOpen();
    if (this.#connection !== undefined) return this.#nested(fn);
    const connection = await this.#pool.getConnection();
    let transaction: MySqlDatabaseImplementation | undefined;
    let began = false;
    let result: T;
    try {
      await this.#verifyConnection(connection);
      await connection.beginTransaction();
      began = true;
      transaction = new MySqlDatabaseImplementation(
        this.#pool,
        connection,
        false,
        1,
        this.#prepared,
        this.#decoderPlans,
        this.#observation,
        this.#safety,
        { active: undefined, batch: undefined, bulk: undefined, execute: undefined, discarded: false, usable: true },
      );
      result = await fn(transaction);
      transaction.#scopeOpen = false;
      transaction.#transactionState!.usable = false;
      await transaction.#assertTransactionReadyForFinalize(true);
      await connection.commit();
    } catch (error) {
      if (transaction !== undefined) {
        transaction.#scopeOpen = false;
        transaction.#transactionState!.usable = false;
        await transaction.#invalidateScope();
      }
      if (transaction === undefined || transaction.#transactionState?.discarded !== true) {
        let recovered = true;
        if (began) {
          try {
            await connection.rollback();
          } catch {
            recovered = false;
            discardFailedRecovery(connection, transaction === undefined ? undefined : transaction.#transactionState);
          }
        }
        if (recovered) {
          try {
            connection.release();
          } catch {
            /* Preserve the original failure. */
          }
        }
      }
      throw error;
    }
    connection.release();
    return result;
  }

  async #nested<T>(fn: (database: MySqlTransaction) => Promise<T>): Promise<T> {
    this.#assertScopeOpen();
    this.#assertConnectionAvailable("start a nested transaction");
    const connection = this.#connection!;
    const depth = this.#depth + 1;
    const savepoint = `typed_sql_${depth}`;
    await this.#verifyConnection(connection);
    await connection.query(`SAVEPOINT ${savepoint}`);
    let transaction: MySqlDatabaseImplementation | undefined;
    try {
      transaction = new MySqlDatabaseImplementation(
        this.#pool,
        connection,
        false,
        depth,
        this.#prepared,
        this.#decoderPlans,
        this.#observation,
        this.#safety,
        this.#transactionState,
      );
      const result = await fn(transaction);
      transaction.#scopeOpen = false;
      await transaction.#assertTransactionReadyForFinalize();
      await connection.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      if (transaction !== undefined) await transaction.#invalidateScope();
      if (this.#transactionState?.usable !== false) {
        try {
          await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        } catch {
          discardFailedRecovery(connection, this.#transactionState);
        }
      }
      throw error;
    }
  }

  async #rejectActiveStreams(): Promise<void> {
    if (this.#streams === undefined || this.#streams.size === 0) return;
    const active = [...this.#streams];
    await Promise.allSettled(active.map((stream) => stream.close()));
    throw new Error(
      `MySQL transaction callback returned with ${active.length} active query stream${active.length === 1 ? "" : "s"}; consume or close every stream before returning`,
    );
  }

  async #closeStreams(): Promise<void> {
    const streams = new Set(this.#streams);
    if (this.#transactionState?.active !== undefined) streams.add(this.#transactionState.active);
    if (streams.size === 0) return;
    await Promise.allSettled([...streams].map((stream) => stream.close()));
  }

  async #invalidateScope(): Promise<void> {
    this.#scopeOpen = false;
    await this.#closeStreams();
    await this.#settleExecutes();
    await this.#settleBatch();
    await this.#settleBulk();
  }

  async #assertTransactionReadyForFinalize(connectionFinalizing = false): Promise<void> {
    if (this.#transactionState?.discarded === true)
      throw new Error("This MySQL transaction connection is no longer active");
    const leakedExecutes = new Set(this.#executes);
    if (this.#transactionState?.execute !== undefined) leakedExecutes.add(this.#transactionState.execute);
    const leakedBatch = this.#transactionState?.batch;
    const leakedBulk = this.#transactionState?.bulk;
    await this.#rejectActiveStreams();
    const active = this.#transactionState?.active;
    if (active !== undefined) {
      await Promise.allSettled([active.close()]);
      throw new Error(
        "MySQL transaction callback returned while a nested query stream owned its connection; await nested work and close every stream before returning",
      );
    }
    if (leakedExecutes.size > 0) {
      await this.#settleExecuteOperations(leakedExecutes);
      throw new Error(
        "MySQL transaction callback returned while an execute operation owned its connection; await execute before returning",
      );
    }
    if (leakedBatch !== undefined) {
      await leakedBatch.completion;
      throw new Error(
        "MySQL transaction callback returned while an ordered batch owned its connection; await the batch before returning",
      );
    }
    if (leakedBulk !== undefined) {
      await leakedBulk.completion;
      throw new Error(
        "MySQL transaction callback returned while LOAD DATA owned its connection; await LOAD DATA before returning",
      );
    }
    if (!connectionFinalizing && this.#transactionState?.usable === false)
      throw new Error("This MySQL transaction connection is no longer active");
  }

  #assertConnectionAvailable(action: string): void {
    if (this.#transactionState?.active !== undefined)
      throw new Error(`Cannot ${action} while a MySQL query stream owns the transaction connection`);
    if (this.#transactionState?.batch !== undefined)
      throw new Error(`Cannot ${action} while a MySQL ordered batch owns the transaction connection`);
    if (this.#transactionState?.bulk !== undefined)
      throw new Error(`Cannot ${action} while MySQL LOAD DATA owns the transaction connection`);
    if (this.#transactionState?.execute !== undefined)
      throw new Error(`Cannot ${action} while a MySQL execute operation owns the transaction connection`);
  }

  #assertBatchCanContinue(operation: MySqlConnectionOperation): void {
    this.#assertScopeOpen();
    if (this.#transactionState?.batch !== operation)
      throw new Error("This MySQL ordered batch no longer owns the transaction connection");
  }

  async #settleBatch(): Promise<void> {
    const batch = this.#transactionState?.batch;
    if (batch !== undefined) await batch.completion;
  }

  async #settleBulk(): Promise<void> {
    const bulk = this.#transactionState?.bulk;
    if (bulk !== undefined) await bulk.completion;
  }

  async #settleExecutes(): Promise<void> {
    const operations = new Set(this.#executes);
    if (this.#transactionState?.execute !== undefined) operations.add(this.#transactionState.execute);
    await this.#settleExecuteOperations(operations);
  }

  async #settleExecuteOperations(operations: ReadonlySet<MySqlConnectionOperation>): Promise<void> {
    for (const operation of operations) {
      await operation.completion;
    }
  }

  #assertScopeOpen(): void {
    if (this.#connection !== undefined && (!this.#scopeOpen || this.#transactionState?.usable === false))
      throw new Error("This MySQL transaction scope is no longer active");
  }

  async close(): Promise<void> {
    if (this.#connection !== undefined) throw new Error("Cannot close a database from inside a transaction");
    if (this.#ownsPool) await this.#pool.end();
  }
}

export function createMySqlDatabase(options: MySqlDatabaseOptions): MySqlDatabase {
  const typePolicy: MySqlRuntimeTypePolicy = { ...defaultRuntimeTypePolicy, ...options.typePolicy };
  if (typePolicy.decimal === "Decimal" && options.decimal === undefined)
    throw new TypeError("decimal=Decimal requires a decimal(value) codec");
  const snapshot = options.compatibilitySnapshot;
  if (snapshot !== undefined) {
    if (snapshot.formatVersion !== 2 || snapshot.dialect !== "mysql" || snapshot.server?.product !== "mysql") {
      throw new MySqlRuntimeCompatibilityError("MySQL runtime compatibility requires an exact MySQL v2 snapshot", [
        "snapshot.server.product",
      ]);
    }
    if (snapshot.dialectVersion !== MYSQL_DIALECT_VERSION) {
      throw new MySqlRuntimeCompatibilityError(
        `MySQL grammar ${MYSQL_DIALECT_VERSION} cannot execute a snapshot compiled for grammar ${snapshot.dialectVersion}`,
        ["snapshot.dialectVersion"],
      );
    }
    try {
      assertMySqlServerEvidence(snapshot.server);
    } catch {
      throw new MySqlRuntimeCompatibilityError("MySQL runtime compatibility snapshot evidence is invalid", [
        "snapshot.server",
      ]);
    }
  }
  const safety: MySqlRuntimeSafetyState = Object.freeze({
    expectedServer: snapshot?.server,
    onWarning: options.onWarning,
    rejectWarnings: options.rejectWarnings ?? false,
  });
  return new MySqlDatabaseImplementation(
    options.pool,
    undefined,
    options.ownsPool ?? false,
    0,
    createMySqlPreparedQueryState(options.preparedStatementLimit, options.preparedCardinalityVariantLimit),
    new MySqlDecoderPlanCache(typePolicy, options.decimal, options.decoderPlanCacheCapacity),
    createMySqlObservationState(options.observer),
    safety,
  );
}
