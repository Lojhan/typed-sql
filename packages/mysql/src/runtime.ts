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

export type { MySqlFieldLike } from "./decoding.js";
export type { MySqlPreparedQueryFactory } from "./prepared.js";
export type { MySqlProtocolStream } from "./stream.js";

export interface MySqlExecutionResult {
  readonly rows: readonly Record<string, unknown>[] | Record<string, unknown>;
  readonly fields?: readonly MySqlFieldLike[];
}

export interface MySqlConnectionLike extends MySqlStreamingConnection {
  execute(sql: string, values?: readonly unknown[]): Promise<MySqlExecutionResult>;
  query(sql: string): Promise<MySqlExecutionResult>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface MySqlPoolLike {
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
}

const defaultRuntimeTypePolicy: MySqlRuntimeTypePolicy = defaultMySqlTypePolicy;
const emptyBatchResults = Object.freeze([]);

export const mysqlRenderer: SqlRenderer = Object.freeze({
  placeholder: () => "?",
  quoteIdentifier: (identifier: string) => `\`${identifier.replaceAll("`", "``")}\``,
});

interface MySqlTransactionConnectionState {
  active: QueryStream<unknown> | undefined;
  batch: MySqlConnectionOperation | undefined;
  execute: MySqlConnectionOperation | undefined;
  usable: boolean;
}

interface MySqlConnectionOperation {
  readonly completion: Promise<void>;
  finish(): void;
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
  readonly #decoderPlans: MySqlDecoderPlanCache;
  readonly #executes: Set<MySqlConnectionOperation> | undefined;
  readonly #streams: Set<QueryStream<unknown>> | undefined;
  readonly #transactionState: MySqlTransactionConnectionState | undefined;
  #scopeOpen = true;

  constructor(
    pool: MySqlPoolLike,
    connection: MySqlConnectionLike | undefined,
    ownsPool: boolean,
    depth: number,
    prepared: MySqlPreparedQueryState,
    decoderPlans: MySqlDecoderPlanCache,
    transactionState?: MySqlTransactionConnectionState,
  ) {
    this.#pool = pool;
    this.#connection = connection;
    this.#ownsPool = ownsPool;
    this.#depth = depth;
    this.#prepared = prepared;
    this.#decoderPlans = decoderPlans;
    this.#executes = connection === undefined ? undefined : new Set();
    this.#streams = connection === undefined ? undefined : new Set();
    this.#transactionState = transactionState;
  }

  async execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> {
    this.#assertScopeOpen();
    this.#assertConnectionAvailable("execute a query");
    if (this.#connection === undefined) return this.#executeOn(this.#pool, query);
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

  async #executeOn<Row, Params extends readonly unknown[]>(
    executor: Pick<MySqlConnectionLike, "execute">,
    query: Query<Row, Params>,
  ): Promise<readonly Row[]> {
    const prepared = this.#prepared.queries.get(query);
    const rendered = prepared?.rendered ?? renderQuery(query, mysqlRenderer);
    const result = await executor.execute(rendered.text, rendered.values.map(encodeMySqlValue));
    if (!Array.isArray(result.rows)) return [];
    const decoders = this.#decoderPlans.get(result.fields ?? []);
    return decodeMySqlRows(result.rows, decoders) as unknown as readonly Row[];
  }

  async batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>> {
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
    const prepared = this.#prepared.queries.get(query);
    const rendered = prepared?.rendered ?? renderQuery(query, mysqlRenderer);
    const batchSize = validateMySqlStreamBatchSize(options.batchSize);
    let queryStream: QueryStream<Row>;
    queryStream = createMySqlQueryStream<Row>({
      openConnection: async () => {
        if (this.#connection !== undefined) {
          this.#assertScopeOpen();
          this.#assertConnectionAvailable("start another query stream");
          this.#transactionState!.active = queryStream as QueryStream<unknown>;
          return { connection: this.#connection, release: false };
        }
        return { connection: await this.#pool.getConnection(), release: true };
      },
      text: rendered.text,
      values: rendered.values.map(encodeMySqlValue),
      batchSize,
      decoderPlans: this.#decoderPlans,
      onClose: () => {
        this.#streams?.delete(queryStream as QueryStream<unknown>);
        if (this.#transactionState?.active === queryStream) this.#transactionState.active = undefined;
      },
    });
    this.#streams?.add(queryStream as QueryStream<unknown>);
    return queryStream;
  }

  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): MySqlPreparedQueryFactory<Arguments, Row, Params> {
    this.#assertScopeOpen();
    return prepareMySqlQuery(this.#prepared, mysqlRenderer, statementName, factory);
  }

  async transaction<T>(fn: (database: MySqlTransaction) => Promise<T>): Promise<T> {
    this.#assertScopeOpen();
    if (this.#connection !== undefined) return this.#nested(fn);
    const connection = await this.#pool.getConnection();
    let transaction: MySqlDatabaseImplementation | undefined;
    let result: T;
    try {
      await connection.beginTransaction();
      transaction = new MySqlDatabaseImplementation(
        this.#pool,
        connection,
        false,
        1,
        this.#prepared,
        this.#decoderPlans,
        { active: undefined, batch: undefined, execute: undefined, usable: true },
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
      try {
        await connection.rollback();
      } catch {
        /* Preserve the original failure. */
      }
      try {
        connection.release();
      } catch {
        /* Preserve the original failure. */
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
          /* Preserve the original failure. */
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
  }

  async #assertTransactionReadyForFinalize(connectionFinalizing = false): Promise<void> {
    const leakedExecutes = new Set(this.#executes);
    if (this.#transactionState?.execute !== undefined) leakedExecutes.add(this.#transactionState.execute);
    const leakedBatch = this.#transactionState?.batch;
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
    if (!connectionFinalizing && this.#transactionState?.usable === false)
      throw new Error("This MySQL transaction connection is no longer active");
  }

  #assertConnectionAvailable(action: string): void {
    if (this.#transactionState?.active !== undefined)
      throw new Error(`Cannot ${action} while a MySQL query stream owns the transaction connection`);
    if (this.#transactionState?.batch !== undefined)
      throw new Error(`Cannot ${action} while a MySQL ordered batch owns the transaction connection`);
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
  return new MySqlDatabaseImplementation(
    options.pool,
    undefined,
    options.ownsPool ?? false,
    0,
    createMySqlPreparedQueryState(),
    new MySqlDecoderPlanCache(typePolicy, options.decimal),
  );
}
