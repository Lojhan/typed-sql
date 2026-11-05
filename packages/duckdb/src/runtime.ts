import { createHash } from "node:crypto";
import {
  assertExecutionCapabilities,
  assertQueryResultTransport,
  type Database,
  type DatabaseObserver,
  decodeQueryResultRows,
  type ExecutionOptions,
  encodeQueryValues,
  executionDeadline,
  getQueryValuePlan,
  type PreparedQueryRenderCache,
  type Query,
  type QueryBatch,
  QueryCancelledError,
  QueryCardinalityError,
  type QueryResults,
  type QueryStream,
  type QueryTransportProfile,
  type QueryValuePlan,
  registerPreparedQuery,
  renderQuery,
  runControlledExecution,
  type StreamOptions,
  startDatabaseObservation,
  validateQueryResultRows,
} from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { decodeDuckDBValue, encodeDuckDBValue } from "./codecs.js";
import { type DuckDBType, formatDuckDBType, parseDuckDBType } from "./native-types.js";
import { duckDBParameterTransport } from "./parameter-transport.js";
import { duckdbRenderer } from "./query.js";
import { duckDBVersionSupport } from "./support.js";
import {
  type DuckDBTypePolicy,
  defaultDuckDBTypePolicy,
  isKnownDuckDBType,
  validateDuckDBTypePolicy,
} from "./type-policy.js";
import { DUCKDB_DIALECT_VERSION } from "./version.js";
export interface DuckDBBinding {
  readonly type: DuckDBType;
  readonly value: unknown;
}
export interface DuckDBNativeColumn {
  readonly name: string;
  readonly type: DuckDBType;
}
export interface DuckDBNativeResult {
  readonly columns: readonly DuckDBNativeColumn[];
  readAll(): Promise<readonly (readonly unknown[])[]>;
  chunks?(): AsyncIterable<readonly (readonly unknown[])[]>;
  close(): void | Promise<void>;
}
export interface DuckDBNativeStatement {
  execute(bindings: readonly DuckDBBinding[], stream?: boolean): Promise<DuckDBNativeResult>;
  close(): void | Promise<void>;
}
export interface DuckDBConnectionLike {
  readonly identity?: object;
  readonly libraryVersion: string;
  prepare(text: string): Promise<DuckDBNativeStatement>;
  interrupt?(): void;
  close?(): void | Promise<void>;
}
export type DuckDBPreparedQueryFactory<Args extends readonly unknown[], Row, Params extends readonly unknown[]> = ((
  ...args: Args
) => Query<Row, Params>) & { readonly statementName: string };
export interface DuckDBTransaction extends Database<DuckDBTransaction> {
  batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
  stream<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: StreamOptions & ExecutionOptions,
  ): QueryStream<Row>;
  prepare<Args extends readonly unknown[], Row, Params extends readonly unknown[]>(
    name: string,
    factory: (...args: Args) => Query<Row, Params>,
  ): DuckDBPreparedQueryFactory<Args, Row, Params>;
}
export interface DuckDBDatabase extends DuckDBTransaction {
  readonly evidence: { readonly libraryVersion: string; readonly typePolicyHash: string };
  readonly queryable: {
    all<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
  };
  close(): Promise<void>;
}
export interface DuckDBDatabaseOptions {
  readonly connection: DuckDBConnectionLike;
  readonly typePolicy?: DuckDBTypePolicy;
  readonly ownsConnection?: boolean;
  readonly observer?: DatabaseObserver;
  readonly preparedCardinalityVariantLimit?: number;
}
class Queue {
  private tail: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    return release;
  }
}
interface Shared {
  readonly queue: Queue;
  transaction?: object;
  broken: boolean;
  dead: boolean;
}
const shared = new WeakMap<object, Shared>();
interface Scope {
  readonly owner: object;
  readonly queue: Queue;
  open: boolean;
  readonly pending: Set<Promise<unknown>>;
  readonly failures: unknown[];
  readonly streams: Set<QueryStream<unknown>>;
}
interface Ready {
  readonly query: Query<unknown>;
  readonly text: string;
  readonly bindings: readonly DuckDBBinding[];
  readonly plan: QueryValuePlan;
  readonly physicalKey: string;
}
/** Owns execution state and exact policies; driver classes and wire conversion stay in explicit adapters. */
export function createDuckDBDatabase(options: DuckDBDatabaseOptions): DuckDBDatabase {
  const connection = options.connection,
    policy = validateDuckDBTypePolicy(options.typePolicy ?? defaultDuckDBTypePolicy),
    key = connection.identity ?? connection;
  if (duckDBVersionSupport(connection.libraryVersion) !== "supported")
    throw new TypeError(`DuckDB runtime requires a qualified engine, received ${connection.libraryVersion}`);
  let state = shared.get(key);
  if (!state) {
    state = { queue: new Queue(), broken: false, dead: false };
    shared.set(key, state);
  }
  const current = state;
  const typePolicyHash = calculateTypePolicyHash(policy),
    profile: QueryTransportProfile = {
      id: "duckdb-native",
      dialect: "duckdb",
      integer: "lossless",
      jsonWire: "text",
      jsonInputWire: "text",
      typePolicyHash,
    };
  const capabilities = Object.freeze({
    cancellation: connection.interrupt !== undefined,
    deadlines: connection.interrupt !== undefined,
  });
  let closed = false;
  const variantCapacity = options.preparedCardinalityVariantLimit ?? 32;
  if (!Number.isSafeInteger(variantCapacity) || variantCapacity < 1 || variantCapacity > 128)
    throw new RangeError("DuckDB prepared cardinality capacity must be1–128");
  const registered = {
    variantCapacity,
    statements: new Map<string, { variants: PreparedQueryRenderCache }>(),
    queries: new WeakMap<object, { statementName: string; rendered: { text: string; values: readonly unknown[] } }>(),
  };
  const nativePrepared = new Map<string, DuckDBNativeStatement>();
  const ensure = (scope?: Scope) => {
    if (closed || current.dead) throw new Error("DuckDB database is closed");
    if (current.broken) throw new Error("DuckDB connection is unusable after failed cleanup");
    if (current.transaction !== scope?.owner)
      throw new Error("DuckDB has an active transaction; use its callback scope");
  };
  const ready = (query: Query<unknown>): Ready => {
    const plan = getQueryValuePlan(query);
    if (!plan) throw new TypeError("DuckDB requires a compiled query value plan");
    assertQueryResultTransport(query, profile);
    const rendered = renderQuery(query, duckdbRenderer),
      values = encodeQueryValues(query, rendered.values, profile);
    if (values.length !== plan.parameters.length)
      throw new TypeError("DuckDB query parameter count differs from its value plan");
    const transports = plan.parameters.map((parameter) => {
      if (!parameter.databaseType) throw new TypeError("DuckDB requires physical target metadata for every parameter");
      return duckDBParameterTransport(parseDuckDBType(parameter.databaseType));
    });
    const physicalRendered = renderQuery(query, {
      ...duckdbRenderer,
      placeholder(index) {
        return transports[index - 1]!.placeholder(duckdbRenderer.placeholder(index));
      },
    });
    const bindings = plan.parameters.map((parameter, i) => {
      if (!parameter.databaseType) throw new TypeError("DuckDB requires physical target metadata for every parameter");
      const type = parseDuckDBType(parameter.databaseType);
      if (!isKnownDuckDBType(type)) throw new TypeError("DuckDB cannot bind an unresolved physical type");
      return {
        type: transports[i]!.wireType,
        value: transports[i]!.encode(encodeDuckDBValue(values[i], type, policy, `parameter ${i + 1}`)),
      };
    });
    for (const column of plan.columns) {
      if (!column.databaseType || !isKnownDuckDBType(parseDuckDBType(column.databaseType)))
        throw new TypeError("DuckDB requires a known physical result type");
    }
    const physicalKey = JSON.stringify(plan.parameters.map((x) => x.databaseType)) + "\0" + typePolicyHash;
    return { query, text: physicalRendered.text, bindings, plan, physicalKey };
  };
  const columns = (result: DuckDBNativeResult, plan?: QueryValuePlan) => {
    const names = result.columns.map((x) => x.name);
    if (new Set(names).size !== names.length) throw new TypeError("DuckDB result columns must have unique names");
    if (
      plan &&
      (plan.columns.length !== result.columns.length ||
        plan.columns.some(
          (column, i) =>
            column.name !== result.columns[i]?.name ||
            formatDuckDBType(parseDuckDBType(column.databaseType!)) !== formatDuckDBType(result.columns[i]!.type),
        ))
    )
      throw new TypeError("DuckDB native result metadata differs from the compiled value plan");
  };
  const decode = (rows: readonly (readonly unknown[])[], fields: readonly DuckDBNativeColumn[]) =>
    rows.map((row) => {
      if (row.length !== fields.length) throw new TypeError("DuckDB native row width differs from metadata");
      return Object.fromEntries(
        fields.map((field, i) => [
          field.name,
          decodeDuckDBValue(row[i], field.type, { ...policy, json: "string" }, `column ${field.name}`),
        ]),
      );
    });
  const acquire = async (scope?: Scope) => {
    ensure(scope);
    return (scope?.queue ?? current.queue).acquire();
  };
  const track = <T>(scope: Scope | undefined, operation: () => Promise<T>): Promise<T> => {
    if (scope && !scope.open) return Promise.reject(new Error("DuckDB transaction scope has completed"));
    const pending = Promise.resolve().then(operation);
    if (scope) {
      scope.pending.add(pending);
      void pending
        .catch((error) => {
          scope.failures.push(error);
        })
        .finally(() => scope.pending.delete(pending));
    }
    return pending;
  };
  const prepared = async (statement: Ready): Promise<{ statement: DuckDBNativeStatement; owned: boolean }> => {
    const registration = registered.queries.get(statement.query);
    if (!registration) return { statement: await connection.prepare(statement.text), owned: true };
    const cacheKey = `${registration.statementName}\0${statement.text}\0${statement.physicalKey}`;
    let native = nativePrepared.get(cacheKey);
    if (native) {
      nativePrepared.delete(cacheKey);
      nativePrepared.set(cacheKey, native);
      return { statement: native, owned: false };
    }
    while (nativePrepared.size >= variantCapacity) {
      const oldest = nativePrepared.keys().next().value as string,
        handle = nativePrepared.get(oldest)!;
      nativePrepared.delete(oldest);
      await handle.close();
    }
    native = await connection.prepare(statement.text);
    nativePrepared.set(cacheKey, native);
    return { statement: native, owned: false };
  };
  const operation = async <Row>(
    statement: Ready,
    scope: Scope | undefined,
    controls: ExecutionOptions = {},
    cardinality: "many" | "one" | "maybeOne" = "many",
  ): Promise<readonly Row[]> => {
    assertExecutionCapabilities(capabilities, controls);
    const release = await acquire(scope);
    let handle: Awaited<ReturnType<typeof prepared>> | undefined, result: DuckDBNativeResult | undefined;
    const fingerprint = `sha256:${createHash("sha256").update(`duckdb\0${DUCKDB_DIALECT_VERSION}\0${statement.text}`).digest("hex")}`;
    const observation = startDatabaseObservation(options.observer, {
      kind: "query",
      dialect: "duckdb",
      grammarVersion: DUCKDB_DIALECT_VERSION,
      transactionDepth: scope ? 1 : 0,
      fingerprint,
      cardinality,
      prepared: registered.queries.has(statement.query),
    });
    try {
      ensure(scope);
      const run = () =>
        runControlledExecution(
          controls,
          async () => {
            handle = await prepared(statement);
            if (controls.signal?.aborted) throw new QueryCancelledError("signal");
            const due = executionDeadline(controls);
            if (due !== undefined && due <= Date.now()) throw new QueryCancelledError("deadline");
            result = await handle.statement.execute(statement.bindings);
            columns(result, statement.plan);
            const rows = decode(await result.readAll(), result.columns),
              decoded = decodeQueryResultRows(statement.query, rows, profile);
            return (await validateQueryResultRows(statement.query, decoded, "duckdb-native")) as readonly Row[];
          },
          () => connection.interrupt?.(),
        );
      const rows = await (observation ? observation.run(run) : run());
      observation?.end({ status: "success", rowCount: rows.length });
      return rows;
    } catch (error) {
      observation?.end(
        {
          status: error instanceof Error && error.name === "QueryCancelledError" ? "cancelled" : "error",
          errorType: error instanceof Error ? error.name : typeof error,
        },
        error,
      );
      throw error;
    } finally {
      try {
        await result?.close();
        if (handle?.owned) await handle.statement.close();
      } catch {
        current.broken = true;
      }
      release();
    }
  };
  const control = async (text: string) => {
    const statement = await connection.prepare(text);
    let result: DuckDBNativeResult | undefined;
    try {
      result = await statement.execute([]);
      await result.readAll();
    } finally {
      await result?.close();
      await statement.close();
    }
  };
  const stream = <Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    scope: Scope | undefined,
    controls: StreamOptions & ExecutionOptions = {},
  ): QueryStream<Row> => {
    const statement = ready(query as unknown as Query<unknown>);
    assertExecutionCapabilities(capabilities, controls);
    if (controls.batchSize !== undefined && (!Number.isSafeInteger(controls.batchSize) || controls.batchSize < 1))
      throw new RangeError("Stream batchSize must be a positive safe integer");
    if (scope && !scope.open) throw new Error("DuckDB transaction scope has completed");
    const generator = (async function* () {
      const release = await acquire(scope);
      let handle: Awaited<ReturnType<typeof prepared>> | undefined, result: DuckDBNativeResult | undefined;
      try {
        ensure(scope);
        handle = await prepared(statement);
        result = await runControlledExecution(
          controls,
          () => handle!.statement.execute(statement.bindings, true),
          () => connection.interrupt?.(),
        );
        columns(result, statement.plan);
        const chunks = result.chunks?.();
        if (!chunks) throw new TypeError("DuckDB driver does not expose native streaming chunks");
        const iterator = chunks[Symbol.asyncIterator]();
        for (;;) {
          const step = await runControlledExecution(
            controls,
            () => iterator.next(),
            () => connection.interrupt?.(),
          );
          if (step.done) break;
          const chunk = step.value;
          const rows = await runControlledExecution(
            controls,
            async () => {
              const decoded = decodeQueryResultRows(statement.query, decode(chunk, result!.columns), profile);
              return validateQueryResultRows(statement.query, decoded, "duckdb-native");
            },
            () => connection.interrupt?.(),
          );
          for (const row of rows) yield row as Row;
        }
      } catch (error) {
        if (scope) scope.failures.push(error);
        throw error;
      } finally {
        try {
          await result?.close();
          if (handle?.owned) await handle.statement.close();
        } catch {
          current.broken = true;
        }
        release();
      }
    })();
    const result: QueryStream<Row> = {
      next: () => generator.next(),
      return: async () => {
        await generator.return(undefined);
        scope?.streams.delete(result as QueryStream<unknown>);
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown) => {
        try {
          return await generator.throw(error);
        } finally {
          scope?.streams.delete(result as QueryStream<unknown>);
        }
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      close: async () => {
        await generator.return(undefined);
        scope?.streams.delete(result as QueryStream<unknown>);
      },
      [Symbol.asyncDispose]: async () => {
        await generator.return(undefined);
        scope?.streams.delete(result as QueryStream<unknown>);
      },
    };
    scope?.streams.add(result as QueryStream<unknown>);
    return result;
  };
  const makeScope = (scope?: Scope): DuckDBTransaction => {
    const all = <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
      track(scope, () => operation<Row>(ready(query as unknown as Query<unknown>), scope, controls));
    return Object.freeze({
      executionCapabilities: capabilities,
      all,
      execute: all,
      one: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
        track(scope, async () => {
          const rows = await operation<Row>(ready(query as unknown as Query<unknown>), scope, controls, "one");
          if (rows.length !== 1) throw new QueryCardinalityError("one", rows.length);
          return rows[0]!;
        }),
      maybeOne: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
        track(scope, async () => {
          const rows = await operation<Row>(ready(query as unknown as Query<unknown>), scope, controls, "maybeOne");
          if (rows.length > 1) throw new QueryCardinalityError("maybeOne", rows.length);
          return rows[0];
        }),
      async transaction<T>(callback: (database: DuckDBTransaction) => Promise<T>): Promise<T> {
        if (scope) throw new TypeError("DuckDB nested transactions are not supported");
        ensure();
        const release = await current.queue.acquire(),
          owner = {},
          local: Scope = {
            owner,
            queue: new Queue(),
            open: true,
            pending: new Set(),
            failures: [],
            streams: new Set(),
          };
        let begun = false;
        try {
          ensure();
          current.transaction = owner;
          await control("BEGIN TRANSACTION");
          begun = true;
          const value = await callback(makeScope(local));
          local.open = false;
          for (const item of [...local.streams]) await item.close();
          await Promise.allSettled([...local.pending]);
          if (local.failures.length) throw local.failures[0];
          await control("COMMIT");
          begun = false;
          return value;
        } catch (error) {
          local.open = false;
          for (const item of [...local.streams]) await item.close().catch(() => undefined);
          await Promise.allSettled([...local.pending]);
          if (begun)
            try {
              await control("ROLLBACK");
            } catch {
              current.broken = true;
            }
          throw error;
        } finally {
          delete current.transaction;
          release();
        }
      },
      batch: <const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>> =>
        track(scope, async () => {
          const statements = queries.map((query) => ready(query as Query<unknown>));
          if (scope) {
            const results = [];
            for (const statement of statements) results.push(await operation(statement, scope));
            return results as QueryResults<Queries>;
          }
          return makeScope().transaction(async (transaction) => {
            const results = [];
            for (const query of queries) results.push(await transaction.all(query as Query<unknown>));
            return results as QueryResults<Queries>;
          });
        }),
      stream<Row, Params extends readonly unknown[]>(
        query: Query<Row, Params>,
        controls?: StreamOptions & ExecutionOptions,
      ) {
        return stream(query, scope, controls);
      },
      prepare<Args extends readonly unknown[], Row, Params extends readonly unknown[]>(
        name: string,
        factory: (...args: Args) => Query<Row, Params>,
      ) {
        ensure(scope);
        return registerPreparedQuery({
          state: registered,
          renderer: duckdbRenderer,
          statementName: name,
          factory,
          metadata: (variant) => ({ statementName: name, rendered: variant.rendered }),
          capacity: { maximum: 128, message: "DuckDB prepared factory limit" },
        });
      },
    });
  };
  const root = makeScope();
  return Object.freeze({
    ...root,
    evidence: Object.freeze({ libraryVersion: connection.libraryVersion, typePolicyHash }),
    queryable: Object.freeze({
      async all<Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<readonly Row[]> {
        const release = await acquire();
        let statement: DuckDBNativeStatement | undefined, result: DuckDBNativeResult | undefined;
        try {
          ensure();
          statement = await connection.prepare(text);
          result = await statement.execute(
            values.map((value) => {
              if (typeof value !== "string")
                throw new TypeError("DuckDB catalog queryable accepts text parameters only");
              return { type: { kind: "scalar" as const, name: "VARCHAR" }, value };
            }),
          );
          columns(result);
          return decode(await result.readAll(), result.columns) as Row[];
        } finally {
          await result?.close();
          await statement?.close();
          release();
        }
      },
    }),
    async close() {
      if (closed) return;
      if (current.transaction) throw new Error("Cannot close DuckDB during an active transaction");
      const release = await current.queue.acquire();
      try {
        if (closed) return;
        for (const handle of nativePrepared.values()) await handle.close();
        nativePrepared.clear();
        closed = true;
        if (options.ownsConnection) {
          await connection.close?.();
          current.dead = true;
        }
      } finally {
        release();
      }
    },
  });
}
