import { createHash } from "node:crypto";
import {
  assertExecutionCapabilities,
  assertQueryResultTransport,
  type Database,
  type DatabaseObserver,
  type DialectServerEvidence,
  databaseErrorCompletion,
  decodeQueryResultRows,
  type ExecutionCapabilities,
  type ExecutionOptions,
  encodeQueryValues,
  getQueryValuePlan,
  observeQueryStream,
  type PreparedQueryRenderCache,
  type Query,
  type QueryBatch,
  QueryCardinalityError,
  type QueryResults,
  type QueryStream,
  type QueryValuePlan,
  queryResultValidationSource,
  registerPreparedQuery,
  renderQuery,
  type SqlRenderer,
  type StreamOptions,
  startDatabaseObservation,
  validateQueryResultRows,
  validateQueryResultStream,
} from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { assertSqlServerRuntimeEvidence } from "./capabilities.js";
import { decodeSqlServerNativeValue, encodeSqlServerParameter, isSqlServerTemporal } from "./decoding.js";
import { requireSqlServerNativeType } from "./native-types.js";
import { parseStatement, walkStatement } from "./parser/index.js";
import { normalizeSqlServerValue, sqlServerRenderer } from "./query.js";
import { defaultSqlServerTypePolicy, type SqlServerTypePolicy, validateSqlServerTypePolicy } from "./type-policy.js";
import { SQLSERVER_DIALECT_VERSION } from "./version.js";
export interface SqlServerField {
  readonly name: string;
  readonly databaseType?: string;
  readonly precision?: number;
  readonly scale?: number;
  readonly length?: number;
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
  /** Native transports may decline a physical plan before dispatch; logical preparation then uses exact raw execution. */
  supportsPreparedPlan?(plan: QueryValuePlan): boolean;
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
export interface SqlServerScope extends Database<SqlServerScope> {
  batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
  prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
  ): SqlServerPreparedQueryFactory<Arguments, Row, Params>;
  unprepare(statementName: string): Promise<void>;
  stream<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, options?: StreamOptions): QueryStream<Row>;
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
  readonly serverEvidence: DialectServerEvidence;
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
  /** Actual-session evidence attested by the application-owned neutral adapter. */
  readonly serverEvidence: DialectServerEvidence;
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
/** Package adapter initialization shares the same ownership lease as execution and transactions. */
export async function withSqlServerInitializationLease<T>(
  connection: SqlServerConnectionLike,
  initialize: () => Promise<T>,
): Promise<T> {
  if (leases.has(connection) || broken.has(connection))
    throw new Error("SQL Server initialization requires an idle usable connection");
  const lease = {};
  leases.set(connection, lease);
  try {
    return await initialize();
  } finally {
    if (leases.get(connection) === lease) leases.delete(connection);
  }
}
export function createSqlServerDatabase(options: SqlServerDatabaseOptions): SqlServerDatabase {
  const { connection } = options;
  if (!options.serverEvidence) throw new TypeError("SQL Server runtime requires actual connection server evidence");
  assertSqlServerRuntimeEvidence(options.serverEvidence);
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
  let closingDatabase: Promise<void> | undefined;
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
    const parsed = parseStatement(logical.text);
    const occurrences = new Set<number>();
    walkStatement(parsed, {
      expression(expression) {
        if (expression.kind !== "parameter") return;
        const expected = `@__typed_sql_${expression.index}`;
        if (
          expression.index < 1 ||
          expression.index > plan.parameters.length ||
          occurrences.has(expression.index) ||
          logical.text.slice(expression.range.start, expression.range.end) !== expected
        )
          throw new TypeError(
            "SQL Server parameters require compiler-owned bound value positions; raw markers and locals cannot be lowered",
          );
        occurrences.add(expression.index);
      },
    });
    if (occurrences.size !== logical.values.length)
      throw new TypeError("SQL Server bound value source identity disagrees with its native parameter plan");
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
          const binary = ["binary", "varbinary", "image"].includes(target.name);
          const nativeType = target.name === "image" ? "varbinary(max)" : (target.baseText ?? target.text);
          const marker = target.collation ? `? COLLATE ${target.collation}` : "?";
          return `(CONVERT(${nativeType}, ${marker}${binary ? ", 2" : isSqlServerTemporal(target) && !["time", "date", "datetime", "smalldatetime"].includes(target.name) ? (target.name === "datetimeoffset" ? ", 127" : ", 126") : ""}))`;
        },
      });
      renderers.set(plan, renderer);
    }
    const rendered = renderQuery(query, renderer);
    const preparedName = preparedState.queries.get(queryResultValidationSource(query))?.statementName;
    if (preparedName) {
      if (!preparedState.statements.has(preparedName)) throw new Error("SQL Server prepared factory has been retired");
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
      const expected = requireSqlServerNativeType(plan.columns[index]!.databaseType!);
      if (field.databaseType) {
        const actual = requireSqlServerNativeType(field.databaseType);
        if (
          actual.name !== expected.name ||
          (field.databaseType.includes("(") &&
            (actual.length !== expected.length ||
              actual.precision !== expected.precision ||
              actual.scale !== expected.scale))
        )
          throw new TypeError("SQL Server native result type disagrees with the compiled target");
      }
      if (
        (field.precision !== undefined && field.precision !== expected.precision) ||
        (field.scale !== undefined && field.scale !== expected.scale) ||
        (field.length !== undefined && field.length !== expected.length)
      )
        throw new TypeError("SQL Server native result precision, scale or length disagrees with the compiled target");
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
    if (!statement.preparedName || connection.supportsPreparedPlan?.(statement.plan) === false)
      return connection.execute(statement.text, statement.values, controls);
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
    cardinality: "many" | "one" | "maybeOne" = "many",
  ): Promise<readonly Row[]> {
    ensureOpen(lease);
    assertExecutionCapabilities(executionCapabilities, controls);
    const statement = compile(query as unknown as Query<unknown>);
    return allCompiled(query, statement, controls, lease, cardinality);
  }
  async function allCompiled<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    statement: PreparedExecution,
    controls: ExecutionOptions = {},
    lease?: object,
    cardinality: "many" | "one" | "maybeOne" = "many",
  ): Promise<readonly Row[]> {
    ensureOpen(lease);
    assertExecutionCapabilities(executionCapabilities, controls);
    const observation = startDatabaseObservation(options.observer, {
      kind: "query",
      dialect: "sqlserver",
      grammarVersion: SQLSERVER_DIALECT_VERSION,
      transactionDepth: lease ? 1 : 0,
      fingerprint: `sha256:${createHash("sha256").update(statement.text).digest("hex")}`,
      cardinality,
      prepared: !!statement.preparedName,
    });
    try {
      const operation = () =>
        leased(lease, async () =>
          validateQueryResultRows(
            query,
            decode<Row>(statement, await execute(statement, controls)),
            `sha256:${createHash("sha256").update(statement.text).digest("hex")}`,
          ),
        );
      const rows = await (observation ? observation.run(operation) : operation());
      if (cardinality === "one" && rows.length !== 1) throw new QueryCardinalityError("one", rows.length);
      if (cardinality === "maybeOne" && rows.length > 1) throw new QueryCardinalityError("maybeOne", rows.length);
      observation?.end({ status: "success", rowCount: rows.length });
      return rows;
    } catch (error) {
      observation?.end(databaseErrorCompletion(error), error);
      throw error;
    }
  }
  function prepare<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
    statementName: string,
    factory: (...args: Arguments) => Query<Row, Params>,
    lease?: object,
  ): SqlServerPreparedQueryFactory<Arguments, Row, Params> {
    ensureOpen(lease);
    return registerPreparedQuery({
      state: preparedState,
      renderer: sqlServerRenderer,
      statementName,
      factory,
      metadata: (variant) => ({ statementName, rendered: variant.rendered }),
      capacity: { maximum: capacity, message: "SQL Server logical prepared capacity exceeded" },
    });
  }
  async function unprepare(statementName: string, lease?: object): Promise<void> {
    await leased(lease, async () => {
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
  }
  const scopeLeases = new WeakMap<SqlServerScope, object>();
  async function batch<const Queries extends readonly unknown[]>(
    queries: QueryBatch<Queries>,
    lease?: object,
  ): Promise<QueryResults<Queries>> {
    ensureOpen(lease);
    const list = [...queries] as Query<unknown>[];
    const statements = list.map(compile);
    const observation = startDatabaseObservation(options.observer, {
      kind: "batch",
      dialect: "sqlserver",
      grammarVersion: SQLSERVER_DIALECT_VERSION,
      transactionDepth: lease ? 1 : 0,
      fingerprints: statements.map(
        (statement) => `sha256:${createHash("sha256").update(statement.text).digest("hex")}`,
      ),
      size: list.length,
    });
    const executeBatch = async (scoped: SqlServerScope) => {
      const results = [];
      const owner = lease ?? scopeLeases.get(scoped);
      if (!owner) throw new Error("SQL Server batch lost its transaction ownership lease");
      for (const statement of statements) results.push(await allCompiled(statement.query, statement, {}, owner));
      return results as unknown as QueryResults<Queries>;
    };
    try {
      const operation = () =>
        list.length
          ? lease
            ? executeBatch(scope(lease))
            : transaction(executeBatch)
          : Promise.resolve([] as unknown as QueryResults<Queries>);
      const result = await (observation ? observation.run(operation) : operation());
      observation?.end({
        status: "success",
        rowCount: (result as readonly unknown[][]).reduce((total, rows) => total + rows.length, 0),
      });
      return result;
    } catch (error) {
      observation?.end(databaseErrorCompletion(error), error);
      throw error;
    }
  }
  function scope(lease?: object): SqlServerScope {
    return Object.freeze({
      executionCapabilities,
      prepare: <Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
        name: string,
        factory: (...args: Arguments) => Query<Row, Params>,
      ) => prepare(name, factory, lease),
      unprepare: (name: string) => unprepare(name, lease),
      stream: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, options?: StreamOptions) =>
        createStream(query, options, lease),
      batch: <const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>) => batch(queries, lease),
      transaction: <T>(_callback: (scope: SqlServerScope) => Promise<T>): Promise<T> =>
        Promise.reject(new Error("Nested SQL Server transactions are unsupported; use the existing callback scope")),
      all: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
        all(query, controls, lease),
      execute: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>) => all(query, {}, lease),
      async one<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) {
        const rows = await all(query, controls, lease, "one");
        return rows[0]!;
      },
      async maybeOne<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) {
        const rows = await all(query, controls, lease, "maybeOne");
        return rows[0];
      },
    });
  }
  async function transaction<T>(callback: (database: SqlServerScope) => Promise<T>): Promise<T> {
    ensureOpen();
    const observation = startDatabaseObservation(options.observer, {
      kind: "transaction",
      dialect: "sqlserver",
      grammarVersion: SQLSERVER_DIALECT_VERSION,
      transactionDepth: 0,
    });
    try {
      const operation = () => transactionRun(callback);
      const result = await (observation ? observation.run(operation) : operation());
      observation?.end({ status: "success" });
      return result;
    } catch (error) {
      observation?.end(databaseErrorCompletion(error), error);
      throw error;
    }
  }
  async function transactionRun<T>(callback: (database: SqlServerScope) => Promise<T>): Promise<T> {
    ensureOpen();
    const token = {};
    leases.set(connection, token);
    let begun = false;
    let beginAttempted = false;
    let active = true;
    let failure: { error: unknown } | undefined;
    let queue = Promise.resolve();
    const pending = new Set<Promise<unknown>>();
    const streams = new Set<QueryStream<unknown>>();
    let activeStream: object | undefined;
    const assertActive = () => {
      if (!active) throw new Error("SQL Server transaction scope is retired");
    };
    const closeStreams = async () => {
      await Promise.allSettled([...streams].map((stream) => stream.close()));
    };
    const control = (text: string) => connection.execute(text, []);
    const base = scope(token);
    const track = <T>(operation: () => Promise<T>, streamOwner?: object): Promise<T> => {
      if (!active) return Promise.reject(new Error("SQL Server transaction scope is retired"));
      if (activeStream && activeStream !== streamOwner)
        return Promise.reject(
          new Error("SQL Server transaction has an active stream; close it before another request"),
        );
      const result = queue.then(() => {
        if (activeStream && activeStream !== streamOwner)
          throw new Error("SQL Server transaction has an active stream");
        return operation();
      });
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
      transaction: <T>(_callback: (scope: SqlServerScope) => Promise<T>): Promise<T> =>
        Promise.reject(new Error("Nested SQL Server transactions are unsupported; use the existing callback scope")),
      prepare: <Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
        name: string,
        factory: (...args: Arguments) => Query<Row, Params>,
      ) => {
        assertActive();
        if (activeStream) throw new Error("SQL Server transaction has an active stream");
        const prepared = base.prepare(name, factory);
        const scopedFactory = (...args: Arguments) => {
          assertActive();
          return prepared(...args);
        };
        Object.defineProperty(scopedFactory, "statementName", { value: prepared.statementName, enumerable: true });
        return scopedFactory as SqlServerPreparedQueryFactory<Arguments, Row, Params>;
      },
      unprepare: (name: string) => track(() => base.unprepare(name)),
      batch: <const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>) =>
        track(() => base.batch(queries)),
      stream: <Row, Params extends readonly unknown[]>(
        query: Query<Row, Params>,
        streamOptions?: StreamOptions,
      ): QueryStream<Row> => {
        assertActive();
        const owner = {};
        const native = createStream(query, streamOptions, token, {
          guard() {
            assertActive();
            if (activeStream && activeStream !== owner) throw new Error("SQL Server transaction has an active stream");
          },
          opened() {
            activeStream = owner;
          },
          closed() {
            if (activeStream === owner) activeStream = undefined;
          },
        });
        const wrapper: QueryStream<Row> = {
          [Symbol.asyncIterator]() {
            return this;
          },
          next: () => track(() => native.next(), owner),
          async close() {
            try {
              await native.close();
            } finally {
              streams.delete(wrapper);
            }
          },
          async return() {
            await this.close();
            return { done: true, value: undefined };
          },
          async throw(error) {
            await this.close();
            throw error;
          },
          async [Symbol.asyncDispose]() {
            await this.close();
          },
        };
        streams.add(wrapper);
        return wrapper;
      },
      all: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
        track(() => base.all(query, controls)),
      execute: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>) => track(() => base.execute(query)),
      one: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
        track(() => base.one(query, controls)),
      maybeOne: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
        track(() => base.maybeOne(query, controls)),
    });
    scopeLeases.set(scoped, token);
    try {
      const before = await control("SELECT @@TRANCOUNT AS count, XACT_STATE() AS state");
      if (Number(before.rows[0]?.count) !== 0 || Number(before.rows[0]?.state) !== 0)
        throw new Error("SQL Server transactions require an idle connection");
      beginAttempted = true;
      await control("BEGIN TRANSACTION");
      begun = true;
      const result = await callback(scoped);
      if (pending.size || activeStream)
        throw new Error("SQL Server transaction callback returned with an in-flight request; await every operation");
      active = false;
      await closeStreams();
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
      await closeStreams();
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
  function createStream<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    streamOptions: StreamOptions = {},
    parentLease?: object,
    hooks?: { guard(): void; opened(): void; closed(): void },
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
          if (lease && !parentLease) leases.delete(connection);
          hooks?.closed();
        }
      })();
      return finishing;
    };
    const start = async () => {
      if (done) return;
      if (opening) return opening;
      opening = (async () => {
        hooks?.guard();
        ensureOpen(parentLease);
        if (!connection.stream) throw new TypeError("This SQL Server connection does not implement protocol streaming");
        lease = parentLease ?? {};
        if (!parentLease) leases.set(connection, lease);
        hooks?.opened();
        try {
          source = connection.stream(statement.text, statement.values, { batchSize });
          const fields = await source.fields;
          if (!done) validateFields(statement.plan, fields);
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
        return release().then(() => ({ done: true as const, value: undefined }));
      },
      throw(error) {
        return release().then(() => {
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
    return observeQueryStream(
      validateQueryResultStream(query, stream, `sha256:${createHash("sha256").update(statement.text).digest("hex")}`),
      options.observer,
      {
        kind: "stream",
        dialect: "sqlserver",
        grammarVersion: SQLSERVER_DIALECT_VERSION,
        transactionDepth: parentLease ? 1 : 0,
        fingerprint: `sha256:${createHash("sha256").update(statement.text).digest("hex")}`,
        prepared: !!statement.preparedName,
      },
    );
  }
  const database: SqlServerDatabase = {
    serverEvidence: options.serverEvidence,
    ...scope(),
    transaction,
    batch,
    prepare,
    unprepare,
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
    stream: createStream,
    async close() {
      if (closingDatabase) return closingDatabase;
      if (closed) return;
      if (leases.has(connection))
        throw new Error("Cannot close SQL Server during an active request, transaction or stream");
      const token = {};
      leases.set(connection, token);
      closed = true;
      closingDatabase = (async () => {
        let failure: unknown;
        try {
          for (const entry of nativePrepared.values())
            try {
              await entry.handle.close();
            } catch (error) {
              failure ??= error;
              broken.add(connection);
            }
          nativePrepared.clear();
          if (options.ownsConnection && connection.close) {
            broken.add(connection);
            try {
              await connection.close();
            } catch (error) {
              failure ??= error;
            }
          }
          if (failure) throw failure;
        } finally {
          if (leases.get(connection) === token) leases.delete(connection);
        }
      })();
      return closingDatabase;
    },
  };
  return Object.freeze(database);
}
