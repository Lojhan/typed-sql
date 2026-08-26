import {
  type Database,
  type Query,
  type QueryStream,
  renderQuery,
  type SqlRenderer,
  type StreamOptions,
} from "@typed-sql/core";
import {
  compileMySqlRowDecoders,
  decodeMySqlRows,
  encodeMySqlValue,
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
  stream<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, options?: StreamOptions): QueryStream<Row>;
  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): MySqlPreparedQueryFactory<Arguments, Row, Params>;
}

export interface MySqlDatabase extends Database<MySqlTransaction> {
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

export const mysqlRenderer: SqlRenderer = Object.freeze({
  placeholder: () => "?",
  quoteIdentifier: (identifier: string) => `\`${identifier.replaceAll("`", "``")}\``,
});

interface MySqlTransactionConnectionState {
  active: QueryStream<unknown> | undefined;
  usable: boolean;
}

class MySqlDatabaseImplementation implements MySqlDatabase {
  readonly #pool: MySqlPoolLike;
  readonly #connection: MySqlConnectionLike | undefined;
  readonly #ownsPool: boolean;
  readonly #typePolicy: MySqlRuntimeTypePolicy;
  readonly #decimal: ((value: string) => unknown) | undefined;
  readonly #depth: number;
  readonly #prepared: MySqlPreparedQueryState;
  readonly #streams: Set<QueryStream<unknown>> | undefined;
  readonly #transactionState: MySqlTransactionConnectionState | undefined;
  #scopeOpen = true;

  constructor(
    pool: MySqlPoolLike,
    connection: MySqlConnectionLike | undefined,
    ownsPool: boolean,
    typePolicy: MySqlRuntimeTypePolicy,
    decimal: ((value: string) => unknown) | undefined,
    depth: number,
    prepared: MySqlPreparedQueryState,
    transactionState?: MySqlTransactionConnectionState,
  ) {
    this.#pool = pool;
    this.#connection = connection;
    this.#ownsPool = ownsPool;
    this.#typePolicy = typePolicy;
    this.#decimal = decimal;
    this.#depth = depth;
    this.#prepared = prepared;
    this.#streams = connection === undefined ? undefined : new Set();
    this.#transactionState = transactionState;
  }

  async execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> {
    this.#assertScopeOpen();
    this.#assertConnectionAvailable("execute a query");
    const prepared = this.#prepared.queries.get(query);
    const rendered = prepared?.rendered ?? renderQuery(query, mysqlRenderer);
    const result = await (this.#connection ?? this.#pool).execute(rendered.text, rendered.values.map(encodeMySqlValue));
    if (!Array.isArray(result.rows)) return [];
    const decoders = compileMySqlRowDecoders(result.fields ?? [], this.#typePolicy, this.#decimal);
    return decodeMySqlRows(result.rows, decoders) as unknown as readonly Row[];
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
      typePolicy: this.#typePolicy,
      ...(this.#decimal === undefined ? {} : { decimal: this.#decimal }),
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
        this.#typePolicy,
        this.#decimal,
        1,
        this.#prepared,
        { active: undefined, usable: true },
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
        this.#typePolicy,
        this.#decimal,
        depth,
        this.#prepared,
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
  }

  async #assertTransactionReadyForFinalize(connectionFinalizing = false): Promise<void> {
    await this.#rejectActiveStreams();
    const active = this.#transactionState?.active;
    if (active !== undefined) {
      await Promise.allSettled([active.close()]);
      throw new Error(
        "MySQL transaction callback returned while a nested query stream owned its connection; await nested work and close every stream before returning",
      );
    }
    if (!connectionFinalizing && this.#transactionState?.usable === false)
      throw new Error("This MySQL transaction connection is no longer active");
  }

  #assertConnectionAvailable(action: string): void {
    if (this.#transactionState?.active !== undefined)
      throw new Error(`Cannot ${action} while a MySQL query stream owns the transaction connection`);
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
    typePolicy,
    options.decimal,
    0,
    createMySqlPreparedQueryState(),
  );
}
