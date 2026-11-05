import { createHash } from "node:crypto";
import {
  assertExecutionCapabilities,
  assertQueryResultTransport,
  type DatabaseObserver,
  databaseErrorCompletion,
  decodeQueryResultRows,
  type ExecutionCapabilities,
  type ExecutionOptions,
  encodeQueryValues,
  getQueryValuePlan,
  type PreparedQueryRenderCache,
  type Query,
  type QueryBatch,
  QueryCardinalityError,
  type QueryResults,
  type QueryStream,
  type QueryValuePlan,
  registerPreparedQuery,
  renderQuery,
  type SqlRenderer,
  type StreamOptions,
  startDatabaseObservation,
} from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { decodeSqlServerNativeValue, encodeSqlServerParameter, isSqlServerTemporal } from "./decoding.js";
import { requireSqlServerNativeType } from "./native-types.js";
import { parseStatement } from "./parser/index.js";
import { normalizeSqlServerValue, sqlServerRenderer } from "./query.js";
import { defaultSqlServerTypePolicy, type SqlServerTypePolicy, validateSqlServerTypePolicy } from "./type-policy.js";
import { SQLSERVER_DIALECT_VERSION } from "./version.js";
export interface SqlServerField {
  readonly name: string;
  readonly databaseType?: string;
  readonly nullable?: boolean;
}
export interface SqlServerExecutionResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly fields?: readonly SqlServerField[];
  readonly resultSets?: number;
  readonly warnings?: readonly { readonly code?: string; readonly message?: string }[];
}
export interface SqlServerNativePrepared {
  execute(values: readonly unknown[], controls?: ExecutionOptions): Promise<SqlServerExecutionResult>;
  close(): Promise<void>;
}
export interface SqlServerProtocolStream extends AsyncIterableIterator<Readonly<Record<string, unknown>>> {
  readonly fields: Promise<readonly SqlServerField[]>;
  readonly connectionReusable?: boolean;
  close(): Promise<void>;
}
export interface SqlServerConnectionLike {
  execute(sql: string, values?: readonly unknown[], controls?: ExecutionOptions): Promise<SqlServerExecutionResult>;
  prepare?(sql: string): Promise<SqlServerNativePrepared>;
  stream?(sql: string, values: readonly unknown[], options: { readonly batchSize: number }): SqlServerProtocolStream;
  readonly executionCapabilities?: ExecutionCapabilities;
  close?(): Promise<void>;
}
export interface SqlServerPreparedQueryFactory<
  Arguments extends readonly unknown[],
  Row,
  Params extends readonly unknown[],
> {
  (...args: Arguments): Query<Row, Params>;
  readonly statementName: string;
}
export interface SqlServerScope {
  readonly executionCapabilities: ExecutionCapabilities;
  all<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    controls?: ExecutionOptions,
  ): Promise<readonly Row[]>;
  execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]>;
  one<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions): Promise<Row>;
  maybeOne<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    controls?: ExecutionOptions,
  ): Promise<Row | undefined>;
}
export interface SqlServerDatabase extends SqlServerScope {
  batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
  transaction<T>(callback: (database: SqlServerScope) => Promise<T>): Promise<T>;
  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): SqlServerPreparedQueryFactory<Arguments, Row, Params>;
  unprepare(statementName: string): Promise<void>;
  stream<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, options?: StreamOptions): QueryStream<Row>;
  readonly queryable: {
    all<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<readonly Row[]>;
  };
  close(): Promise<void>;
}
export interface SqlServerDatabaseOptions {
  readonly connection: SqlServerConnectionLike;
  readonly ownsConnection?: boolean;
  readonly typePolicy?: SqlServerTypePolicy;
  readonly typePolicyHash?: string;
  readonly decimal?: { decode(value: string): unknown; encode(value: unknown): string };
  readonly observer?: DatabaseObserver;
  readonly preparedStatementLimit?: number;
  readonly preparedCardinalityVariantLimit?: number;
  /** Bound values larger than this are rejected before native preparation/execution. Default1MiB. */
  readonly maximumPreparedValueBytes?: number;
}
interface PreparedExecution {
  readonly query: Query<unknown>;
  readonly plan: QueryValuePlan;
  readonly text: string;
  readonly values: readonly unknown[];
  readonly preparedName?: string;
}
const leases = new WeakMap<SqlServerConnectionLike, object>();
const broken = new WeakSet<SqlServerConnectionLike>();
export function createSqlServerDatabase(options: SqlServerDatabaseOptions): SqlServerDatabase {
  const { connection } = options;
  if (leases.has(connection)) throw new Error("SQL Server wrappers require an idle connection");
  const policy = validateSqlServerTypePolicy(options.typePolicy ?? defaultSqlServerTypePolicy);
  const policyHash = options.typePolicyHash ?? calculateTypePolicyHash(policy);
  const profile = {
    id: "sqlserver-native",
    dialect: "sqlserver",
    typePolicyHash: policyHash,
    integer: "lossless" as const,
    jsonWire: "text" as const,
    normalizeValue: normalizeSqlServerValue,
  };
  if (policy.decimal === "Decimal" && !options.decimal)
    throw new TypeError("SQL Server Decimal policy requires encode/decode codecs");
  const capacity = options.preparedStatementLimit ?? 256,
    variantCapacity = options.preparedCardinalityVariantLimit ?? 32,
    maxPreparedBytes = options.maximumPreparedValueBytes ?? 1024 * 1024;
  for (const [name, value] of Object.entries({ capacity, variantCapacity, maxPreparedBytes }))
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  const executionCapabilities = Object.freeze(
    connection.executionCapabilities ?? { cancellation: false, deadlines: false },
  );
  const renderers = new WeakMap<QueryValuePlan, SqlRenderer>();
  const preparedState = {
    variantCapacity,
    statements: new Map<string, { readonly variants: PreparedQueryRenderCache }>(),
    queries: new WeakMap<
      object,
      { readonly statementName: string; readonly rendered: ReturnType<typeof renderQuery> }
    >(),
  };
  const nativePrepared = new Map<string, { readonly name: string; readonly handle: SqlServerNativePrepared }>();
  let closed = false;
  function ensureOpen(lease?: object): void {
    if (closed) throw new Error("SQL Server database is closed");
    if (broken.has(connection)) throw new Error("SQL Server connection is unusable after failed cleanup");
    if (leases.get(connection) !== lease)
      throw new Error("SQL Server connection is leased by an active operation; use the transaction callback scope");
  }
  function compile(query: Query<unknown>): PreparedExecution {
    const plan = getQueryValuePlan(query);
    if (plan?.dialect !== "sqlserver")
      throw new TypeError("SQL Server requires a compiled SQL Server query value plan");
    assertQueryResultTransport(query, profile);
    if (plan.parameters.length > 2100)
      throw new RangeError("SQL Server supports at most2100 physical bound parameters");
    for (const descriptor of [...plan.columns, ...plan.parameters]) {
      if (!descriptor.databaseType)
        throw new TypeError("SQL Server native target metadata is missing; regenerate with a compatible compiler/core");
      requireSqlServerNativeType(descriptor.databaseType);
    }
    const logical = renderQuery(query, sqlServerRenderer);
    parseStatement(logical.text);
    if (logical.values.length !== plan.parameters.length)
      throw new TypeError("SQL Server parameter plan does not match bound value occurrences");
    const logicalValues = encodeQueryValues(query, logical.values, profile);
    const values = logicalValues.map((value, index) =>
      encodeSqlServerParameter(value, plan.parameters[index]!, policy, options.decimal?.encode),
    );
    let renderer = renderers.get(plan);
    if (!renderer) {
      renderer = Object.freeze({
        quoteIdentifier: sqlServerRenderer.quoteIdentifier,
        placeholder(index: number) {
          const descriptor = plan!.parameters[index - 1];
          if (!descriptor?.databaseType) throw new TypeError("Missing native SQL Server bound target");
          const target = requireSqlServerNativeType(descriptor.databaseType);
          const nativeType = target.baseText ?? target.text;
          const marker = target.collation ? `? COLLATE ${target.collation}` : "?";
          return `CONVERT(${nativeType}, ${marker}${isSqlServerTemporal(target) && !["time", "date", "datetime", "smalldatetime"].includes(target.name) ? (target.name === "datetimeoffset" ? ", 127" : ", 126") : ""})`;
        },
      });
      renderers.set(plan, renderer);
    }
    const rendered = renderQuery(query, renderer);
    const preparedName = preparedState.queries.get(query)?.statementName;
    if (preparedName) {
      for (const value of values) {
        const bytes = typeof value === "string" ? value.length * 2 : value instanceof Uint8Array ? value.byteLength : 0;
        if (bytes > maxPreparedBytes)
          throw new RangeError("SQL Server prepared value exceeds the configured byte limit");
      }
    }
    return { query, plan, text: rendered.text, values, ...(preparedName ? { preparedName } : {}) };
  }
  function validateFields(plan: QueryValuePlan, fields: readonly SqlServerField[] | undefined): void {
    if (!fields) return;
    if (fields.length !== plan.columns.length)
      throw new TypeError("SQL Server result metadata width disagrees with the compiled plan");
    const names = new Set<string>();
    for (const [index, field] of fields.entries()) {
      if (names.has(field.name) || field.name !== plan.columns[index]?.name)
        throw new TypeError("SQL Server result column identities disagree with the compiled plan");
      names.add(field.name);
    }
  }
  function decode<Row>(statement: PreparedExecution, result: SqlServerExecutionResult): readonly Row[] {
    if (result.resultSets !== undefined && result.resultSets > (statement.plan.columns.length ? 1 : 0))
      throw new TypeError("SQL Server returned multiple or unexpected result sets");
    if (result.warnings?.some((warning) => warning.code === "01004"))
      throw new RangeError("SQL Server native transport truncated a result value");
    validateFields(statement.plan, result.fields);
    const rows = result.rows.map((row) =>
      Object.fromEntries(
        statement.plan.columns.map((column) => {
          if (!Object.hasOwn(row, column.name)) throw new TypeError("SQL Server result omitted a compiled column");
          return [column.name, decodeSqlServerNativeValue(row[column.name], column, policy, options.decimal?.decode)];
        }),
      ),
    );
    return decodeQueryResultRows(statement.query, rows, profile) as readonly Row[];
  }
  async function execute(
    statement: PreparedExecution,
    controls: ExecutionOptions = {},
  ): Promise<SqlServerExecutionResult> {
    assertExecutionCapabilities(executionCapabilities, controls);
    if (!statement.preparedName) return connection.execute(statement.text, statement.values, controls);
    if (!connection.prepare)
      throw new TypeError("This SQL Server connection does not implement native prepared statements");
    const key = JSON.stringify([
      statement.preparedName,
      statement.text,
      statement.plan.parameters.map((value) => value.databaseType),
      policyHash,
    ]);
    let prepared = nativePrepared.get(key);
    if (!prepared) {
      if (nativePrepared.size >= capacity) throw new RangeError("SQL Server native prepared cache capacity exceeded");
      prepared = { name: statement.preparedName, handle: await connection.prepare(statement.text) };
      nativePrepared.set(key, prepared);
    }
    return prepared.handle.execute(statement.values, controls);
  }
  async function leased<T>(lease: object | undefined, operation: () => Promise<T>): Promise<T> {
    ensureOpen(lease);
    if (lease) return operation();
    const token = {};
    leases.set(connection, token);
    try {
      return await operation();
    } finally {
      leases.delete(connection);
    }
  }
  async function all<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    controls: ExecutionOptions = {},
    lease?: object,
  ): Promise<readonly Row[]> {
    ensureOpen(lease);
    assertExecutionCapabilities(executionCapabilities, controls);
    const statement = compile(query as unknown as Query<unknown>);
    const observation = startDatabaseObservation(options.observer, {
      kind: "query",
      dialect: "sqlserver",
      grammarVersion: SQLSERVER_DIALECT_VERSION,
      transactionDepth: lease ? 1 : 0,
      fingerprint: `sha256:${createHash("sha256").update(statement.text).digest("hex")}`,
      cardinality: "many",
      prepared: !!statement.preparedName,
    });
    try {
      const operation = () => leased(lease, async () => decode<Row>(statement, await execute(statement, controls)));
      const rows = await (observation ? observation.run(operation) : operation());
      observation?.end({ status: "success", rowCount: rows.length });
      return rows;
    } catch (error) {
      observation?.end(databaseErrorCompletion(error), error);
      throw error;
    }
  }
  function scope(lease?: object): SqlServerScope {
    return Object.freeze({
      executionCapabilities,
      all: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
        all(query, controls, lease),
      execute: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>) => all(query, {}, lease),
      async one<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) {
        const rows = await all(query, controls, lease);
        if (rows.length !== 1) throw new QueryCardinalityError("one", rows.length);
        return rows[0]!;
      },
      async maybeOne<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) {
        const rows = await all(query, controls, lease);
        if (rows.length > 1) throw new QueryCardinalityError("maybeOne", rows.length);
        return rows[0];
      },
    });
  }
  async function transaction<T>(callback: (database: SqlServerScope) => Promise<T>): Promise<T> {
    ensureOpen();
    const token = {};
    leases.set(connection, token);
    let begun = false;
    let beginAttempted = false;
    let active = true;
    let failure: { error: unknown } | undefined;
    let queue = Promise.resolve();
    const pending = new Set<Promise<unknown>>();
    const control = (text: string) => connection.execute(text, []);
    const base = scope(token);
    const track = <T>(operation: () => Promise<T>): Promise<T> => {
      if (!active) return Promise.reject(new Error("SQL Server transaction scope is retired"));
      const result = queue.then(operation);
      queue = result.then(
        () => undefined,
        (error) => {
          failure ??= { error };
        },
      );
      pending.add(result);
      void result.then(
        () => pending.delete(result),
        () => pending.delete(result),
      );
      return result;
    };
    const scoped: SqlServerScope = Object.freeze({
      executionCapabilities,
      all: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
        track(() => base.all(query, controls)),
      execute: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>) => track(() => base.execute(query)),
      one: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
        track(() => base.one(query, controls)),
      maybeOne: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
        track(() => base.maybeOne(query, controls)),
    });
    try {
      const before = await control("SELECT @@TRANCOUNT AS count, XACT_STATE() AS state");
      if (Number(before.rows[0]?.count) !== 0 || Number(before.rows[0]?.state) !== 0)
        throw new Error("SQL Server transactions require an idle connection");
      beginAttempted = true;
      await control("BEGIN TRANSACTION");
      begun = true;
      const result = await callback(scoped);
      active = false;
      await Promise.allSettled([...pending]);
      await queue;
      if (failure) throw failure.error;
      const state = await control("SELECT @@TRANCOUNT AS count, XACT_STATE() AS state");
      if (Number(state.rows[0]?.count) !== 1 || Number(state.rows[0]?.state) !== 1)
        throw new Error("SQL Server transaction is not committable or changed its nesting level");
      await control("COMMIT TRANSACTION");
      begun = false;
      return result;
    } catch (error) {
      active = false;
      await Promise.allSettled([...pending]);
      await queue;
      if (begun || beginAttempted) {
        try {
          await control("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION");
        } catch {
          broken.add(connection);
        }
      }
      throw error;
    } finally {
      active = false;
      leases.delete(connection);
    }
  }
  const database: SqlServerDatabase = {
    ...scope(),
    transaction,
    async batch(queries) {
      ensureOpen();
      const values = [...queries] as Query<unknown>[];
      for (const query of values) compile(query);
      if (!values.length) return [] as unknown as QueryResults<typeof queries>;
      return transaction(async (scoped) => {
        const results = [];
        for (const query of values) results.push(await scoped.all(query));
        return results as unknown as QueryResults<typeof queries>;
      });
    },
    prepare(statementName, factory) {
      ensureOpen();
      return registerPreparedQuery({
        state: preparedState,
        renderer: sqlServerRenderer,
        statementName,
        factory,
        metadata: (variant) => ({ statementName, rendered: variant.rendered }),
        capacity: { maximum: capacity, message: "SQL Server logical prepared capacity exceeded" },
      });
    },
    async unprepare(statementName) {
      await leased(undefined, async () => {
        for (const [key, entry] of nativePrepared)
          if (entry.name === statementName) {
            try {
              await entry.handle.close();
            } catch (error) {
              broken.add(connection);
              throw error;
            } finally {
              nativePrepared.delete(key);
            }
          }
        preparedState.statements.delete(statementName);
      });
    },
    queryable: Object.freeze({
      async all<Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<readonly Row[]> {
        return leased(undefined, async () => {
          const result = await connection.execute(text, values);
          if ((result.resultSets ?? 0) > 1) throw new TypeError("Schema query returned multiple result sets");
          return result.rows as readonly Row[];
        });
      },
    }),
    stream<Row, Params extends readonly unknown[]>(
      query: Query<Row, Params>,
      streamOptions: StreamOptions = {},
    ): QueryStream<Row> {
      const batchSize = streamOptions.batchSize ?? 100;
      if (!Number.isSafeInteger(batchSize) || batchSize < 1)
        throw new RangeError("SQL Server stream batchSize must be a positive safe integer");
      const statement = compile(query as unknown as Query<unknown>);
      let source: SqlServerProtocolStream | undefined;
      let lease: object | undefined;
      let done = false;
      let opening: Promise<void> | undefined;
      let finishing: Promise<void> | undefined;
      let queued = Promise.resolve();
      const release = (): Promise<void> => {
        if (finishing) return finishing;
        done = true;
        finishing = (async () => {
          try {
            await source?.close();
            if (source?.connectionReusable === false) broken.add(connection);
          } catch (error) {
            broken.add(connection);
            throw error;
          } finally {
            if (lease) leases.delete(connection);
          }
        })();
        return finishing;
      };
      const start = async () => {
        if (done) return;
        if (opening) return opening;
        opening = (async () => {
          ensureOpen();
          if (!connection.stream)
            throw new TypeError("This SQL Server connection does not implement protocol streaming");
          lease = {};
          leases.set(connection, lease);
          try {
            source = connection.stream(statement.text, statement.values, { batchSize });
            validateFields(statement.plan, await source.fields);
          } catch (error) {
            await release();
            throw error;
          }
        })();
        return opening;
      };
      const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = queued.then(operation, operation);
        queued = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      };
      const stream: QueryStream<Row> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          return enqueue(async () => {
            if (done) return { done: true, value: undefined };
            try {
              await start();
              if (done) return { done: true, value: undefined };
              const result = await source!.next();
              if (done) return { done: true, value: undefined };
              if (result.done) {
                await release();
                return { done: true, value: undefined };
              }
              return { done: false, value: decode<Row>(statement, { rows: [result.value] })[0]! };
            } catch (error) {
              await release();
              throw error;
            }
          });
        },
        return() {
          return enqueue(async () => {
            await release();
            return { done: true, value: undefined };
          });
        },
        throw(error) {
          return enqueue(async () => {
            await release();
            throw error;
          });
        },
        close() {
          return release();
        },
        [Symbol.asyncDispose]() {
          return this.close();
        },
      };
      return stream;
    },
    async close() {
      if (closed) return;
      if (leases.has(connection))
        throw new Error("Cannot close SQL Server during an active request, transaction or stream");
      let failure: unknown;
      for (const entry of nativePrepared.values()) {
        try {
          await entry.handle.close();
        } catch (error) {
          failure ??= error;
          broken.add(connection);
        }
      }
      nativePrepared.clear();
      closed = true;
      if (options.ownsConnection && connection.close) {
        try {
          await connection.close();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    },
  };
  return Object.freeze(database);
}
