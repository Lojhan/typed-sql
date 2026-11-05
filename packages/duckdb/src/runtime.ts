import { createHash, randomUUID } from "node:crypto";
import {
  type AdapterCapabilityResolver,
  adapterCapabilities,
  assertExecutionCapabilities,
  assertQueryResultTransport,
  createAdapterCapabilityResolver,
  type Database,
  type DatabaseObserver,
  type DatabaseOperationStart,
  type DialectServerEvidence,
  databaseErrorCompletion,
  decodeQueryResultRows,
  type ExecutionOptions,
  encodeQueryValues,
  executionDeadline,
  getQueryValuePlan,
  type LiveQueryVerifier,
  observeQueryStream,
  type PreparedQueryRenderCache,
  type Query,
  type QueryBatch,
  QueryCancelledError,
  QueryCardinalityError,
  type QueryPlanInspector,
  type QueryResults,
  type QueryStream,
  type QueryTransportProfile,
  type QueryValuePlan,
  queryResultValidationSource,
  registerPreparedQuery,
  renderQuery,
  runControlledExecution,
  type SchemaSnapshot,
  type StreamOptions,
  startDatabaseObservation,
  validateQueryResultRows,
  validateQueryResultStream,
} from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { createDuckDBAppenderCapability, type DuckDBAppenderCapability, duckdbAppender } from "./bulk.js";

export type { DuckDBAppenderCapability, DuckDBAppenderProgress, DuckDBAppendOptions } from "./bulk.js";
export { duckdbAppender } from "./bulk.js";

import { decodeDuckDBValue, encodeDuckDBValue } from "./codecs.js";
import { type DuckDBType, formatDuckDBType, parseDuckDBType } from "./native-types.js";
import { duckDBParameterTransport } from "./parameter-transport.js";
import { duckdbRenderer } from "./query.js";
import { createDuckDBLiveVerifier, createDuckDBPlanInspector, type DuckDBServiceTransport } from "./services.js";
import { assertDuckDBSemanticEvidence, duckDBEvidenceDifferences } from "./settings.js";
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
  readonly columns?: readonly DuckDBNativeColumn[];
  readonly parameters?: readonly (DuckDBType | undefined)[];
  execute(bindings: readonly DuckDBBinding[], stream?: boolean): Promise<DuckDBNativeResult>;
  close(): void | Promise<void>;
}
export interface DuckDBNativeAppender {
  readonly columns: readonly DuckDBType[];
  append(rows: readonly (readonly DuckDBBinding[])[]): void | Promise<void>;
  close(): void | Promise<void>;
}
export interface DuckDBConnectionLike {
  readonly identity?: object;
  readonly libraryVersion: string;
  readServerEvidence?(): Promise<DialectServerEvidence>;
  prepare(text: string): Promise<DuckDBNativeStatement>;
  createAppender?(table: string): Promise<DuckDBNativeAppender>;
  interrupt?(): void;
  close?(): void | Promise<void>;
}
export type DuckDBPreparedQueryFactory<Args extends readonly unknown[], Row, Params extends readonly unknown[]> = ((
  ...args: Args
) => Query<Row, Params>) & { readonly statementName: string };
export interface DuckDBTransaction extends Database<DuckDBTransaction> {
  readonly [adapterCapabilities]: AdapterCapabilityResolver;
  unprepare(name: string): Promise<void>;
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
  readonly liveVerifier: LiveQueryVerifier;
  readonly planInspector: QueryPlanInspector;
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
  readonly compatibilitySnapshot?: SchemaSnapshot;
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
  readonly activeStreams: Set<QueryStream<unknown>>;
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
    queries: new WeakMap<
      object,
      { owner: object; statementName: string; rendered: { text: string; values: readonly unknown[] } }
    >(),
  };
  const nativePrepared = new Map<string, DuckDBNativeStatement>();
  const preparedOwners = new Map<string, object>();
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
    const physicalTargets = transports.map((transport) => formatDuckDBType(transport.wireType));
    if (physicalTargets.reduce((bytes, text) => bytes + new TextEncoder().encode(text).byteLength, 0) > 1048576)
      throw new RangeError("DuckDB aggregate physical type text limit");
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
    const physicalKey = JSON.stringify({
      lowering: "typed-null-witness-v1",
      original: plan.parameters.map((x) => x.databaseType),
      physical: physicalTargets,
      policy: typePolicyHash,
    });
    return { query, text: physicalRendered.text, bindings, plan, physicalKey };
  };
  const columns = (result: Pick<DuckDBNativeResult, "columns">, plan?: QueryValuePlan) => {
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
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      pending = Promise.reject(error);
    }
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
    const registration = registered.queries.get(queryResultValidationSource(statement.query));
    if (!registration) return { statement: await connection.prepare(statement.text), owned: true };
    if (preparedOwners.get(registration.statementName) !== registration.owner)
      throw new Error("DuckDB prepared factory has been retired");
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
      await cleanup(undefined, handle, false);
    }
    native = await connection.prepare(statement.text);
    nativePrepared.set(cacheKey, native);
    return { statement: native, owned: false };
  };
  const cleanup = async (
    result: DuckDBNativeResult | undefined,
    statement: DuckDBNativeStatement | undefined,
    preserveFailure: boolean,
  ) => {
    let failure: unknown;
    let failed = false;
    for (const resource of [result, statement]) {
      try {
        await resource?.close();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
        current.broken = true;
      }
    }
    if (failed && !preserveFailure) throw failure;
  };
  let expectedEvidence = options.compatibilitySnapshot?.server;
  if (options.compatibilitySnapshot && (!expectedEvidence || options.compatibilitySnapshot.dialect !== "duckdb"))
    throw new TypeError("DuckDB compatibility snapshot requires DuckDB server evidence");
  const verifyConnection = async () => {
    if (!connection.readServerEvidence) {
      if (expectedEvidence) throw new TypeError("DuckDB adapter cannot prove runtime server/settings compatibility");
      return;
    }
    const actual = await connection.readServerEvidence();
    assertDuckDBSemanticEvidence(actual);
    if (expectedEvidence) {
      const differences = duckDBEvidenceDifferences(expectedEvidence, actual);
      if (differences.length) throw new TypeError(`DuckDB runtime evidence differs (${differences.join(", ")})`);
    } else expectedEvidence = actual;
  };
  const fingerprint = (query: Query<unknown>) =>
    `sha256:${createHash("sha256")
      .update(`duckdb\0${DUCKDB_DIALECT_VERSION}\0${renderQuery(query, duckdbRenderer).text}`)
      .digest("hex")}`;
  const observe = async <T>(start: DatabaseOperationStart, operation: () => Promise<T>): Promise<T> => {
    const observation = startDatabaseObservation(options.observer, start);
    if (!observation) return operation();
    try {
      const result = await observation.run(operation);
      observation.end({ status: "success" });
      return result;
    } catch (error) {
      observation.end(databaseErrorCompletion(error), error);
      throw error;
    }
  };
  const verifyParameters = (native: DuckDBNativeStatement, bindings: readonly DuckDBBinding[]) => {
    if (!native.parameters) return;
    if (native.parameters.length !== bindings.length)
      throw new TypeError("DuckDB native parameter count differs from the compiled value plan");
    for (let i = 0; i < bindings.length; i++) {
      const expected = native.parameters[i];
      if (expected && isKnownDuckDBType(expected) && formatDuckDBType(expected) !== formatDuckDBType(bindings[i]!.type))
        throw new TypeError(`DuckDB native parameter ${i + 1} metadata differs from the compiled physical value plan`);
    }
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
    let failed = true;
    const observation = startDatabaseObservation(options.observer, {
      kind: "query",
      dialect: "duckdb",
      grammarVersion: DUCKDB_DIALECT_VERSION,
      transactionDepth: scope ? 1 : 0,
      fingerprint: fingerprint(statement.query),
      cardinality,
      prepared: registered.queries.has(queryResultValidationSource(statement.query)),
    });
    try {
      ensure(scope);
      await verifyConnection();
      const run = () =>
        runControlledExecution(
          controls,
          async () => {
            handle = await prepared(statement);
            verifyParameters(handle.statement, statement.bindings);
            if (handle.statement.columns && statement.plan.columns.length)
              columns({ columns: handle.statement.columns }, statement.plan);
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
      if (cardinality === "one" && rows.length !== 1) throw new QueryCardinalityError("one", rows.length);
      if (cardinality === "maybeOne" && rows.length > 1) throw new QueryCardinalityError("maybeOne", rows.length);
      const finishedResult = result,
        finishedStatement = handle?.owned ? handle.statement : undefined;
      result = undefined;
      handle = undefined;
      await cleanup(finishedResult, finishedStatement, false);
      failed = false;
      observation?.end({ status: "success", rowCount: rows.length });
      return rows;
    } catch (error) {
      observation?.end(databaseErrorCompletion(error), error);
      throw error;
    } finally {
      try {
        await cleanup(result, handle?.owned ? handle.statement : undefined, failed);
      } finally {
        release();
      }
    }
  };
  const control = async (text: string) => {
    const statement = await connection.prepare(text);
    let result: DuckDBNativeResult | undefined;
    let failed = true;
    try {
      result = await statement.execute([]);
      await result.readAll();
      failed = false;
    } finally {
      await cleanup(result, statement, failed);
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
      if (scope && !scope.open) throw new Error("DuckDB transaction scope has completed");
      const release = await acquire(scope);
      let handle: Awaited<ReturnType<typeof prepared>> | undefined, result: DuckDBNativeResult | undefined;
      let failed = false;
      try {
        ensure(scope);
        await verifyConnection();
        handle = await prepared(statement);
        verifyParameters(handle.statement, statement.bindings);
        if (handle.statement.columns && statement.plan.columns.length)
          columns({ columns: handle.statement.columns }, statement.plan);
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
          for (const raw of chunk) {
            if (controls.signal?.aborted) throw new QueryCancelledError("signal");
            const due = executionDeadline(controls);
            if (due !== undefined && due <= Date.now()) throw new QueryCancelledError("deadline");
            const decoded = decodeQueryResultRows(statement.query, decode([raw], result.columns), profile);
            yield decoded[0] as Row;
          }
        }
      } catch (error) {
        failed = true;
        if (scope) scope.failures.push(error);
        throw error;
      } finally {
        try {
          await cleanup(result, handle?.owned ? handle.statement : undefined, failed);
        } finally {
          release();
        }
      }
    })();
    let exposed: QueryStream<Row>;
    const retire = () => {
      scope?.streams.delete(exposed as QueryStream<unknown>);
      scope?.activeStreams.delete(exposed as QueryStream<unknown>);
    };
    const result: QueryStream<Row> = {
      next: async () => {
        scope?.activeStreams.add(exposed as QueryStream<unknown>);
        const next = await generator.next();
        if (next.done) retire();
        return next;
      },
      return: async () => {
        await generator.return(undefined);
        retire();
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown) => {
        try {
          return await generator.throw(error);
        } finally {
          retire();
        }
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      close: async () => {
        await generator.return(undefined);
        retire();
      },
      [Symbol.asyncDispose]: async () => {
        await generator.return(undefined);
        retire();
      },
    };
    const validated = validateQueryResultStream(query, result, "duckdb-native");
    const tracked: QueryStream<Row> = {
      ...validated,
      next() {
        return track(scope, () =>
          runControlledExecution(
            controls,
            () => validated.next(),
            () => connection.interrupt?.(),
          ),
        );
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    exposed = observeQueryStream(validated === result ? result : tracked, options.observer, {
      kind: "stream",
      dialect: "duckdb",
      grammarVersion: DUCKDB_DIALECT_VERSION,
      transactionDepth: scope ? 1 : 0,
      fingerprint: fingerprint(statement.query),
      prepared: registered.queries.has(queryResultValidationSource(query)),
    });
    scope?.streams.add(exposed as QueryStream<unknown>);
    return exposed;
  };
  const transaction = async <T>(scope: Scope | undefined, callback: (local: Scope) => Promise<T>): Promise<T> => {
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
        activeStreams: new Set(),
      };
    let begun = false;
    try {
      ensure();
      current.transaction = owner;
      await verifyConnection();
      begun = true;
      await control("BEGIN TRANSACTION");
      const value = await callback(local);
      const unfinished = local.pending.size > 0 || local.activeStreams.size > 0;
      local.open = false;
      for (const item of [...local.streams]) await item.close();
      await Promise.allSettled([...local.pending]);
      if (local.failures.length) throw local.failures[0];
      if (unfinished) throw new Error("DuckDB transaction callback returned with unfinished operations or streams");
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
  };
  const makeScope = (scope?: Scope): DuckDBTransaction => {
    const run = <Row, Params extends readonly unknown[], Output>(
      query: Query<Row, Params>,
      controls: ExecutionOptions | undefined,
      cardinality: "many" | "one" | "maybeOne",
      mapRows: (rows: readonly Row[]) => Output,
    ): Promise<Output> => {
      let statement: Ready;
      try {
        statement = ready(query as unknown as Query<unknown>);
      } catch (error) {
        return track<Output>(scope, () => Promise.reject(error));
      }
      return track(scope, async () => mapRows(await operation<Row>(statement, scope, controls, cardinality)));
    };
    const all = <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
      run(query, controls, "many", (rows) => rows);
    const appender = createDuckDBAppenderCapability({
      prepare(query) {
        const compiled = ready(query),
          rendered = renderQuery(query, duckdbRenderer);
        const values = encodeQueryValues(query, rendered.values, profile);
        if (compiled.plan.columns.length !== 0) throw new TypeError("DuckDB appender requires a command query");
        return {
          text: rendered.text,
          bindings: compiled.plan.parameters.map((parameter, i) => {
            const type = parseDuckDBType(parameter.databaseType!);
            return { type, value: encodeDuckDBValue(values[i], type, policy, `appender parameter ${i + 1}`) };
          }),
        };
      },
      transfer(target, initial, chunks, controls) {
        assertExecutionCapabilities(capabilities, controls);
        return track(scope, async () => {
          const append = async (local: Scope) => {
            const release = await acquire(local);
            let appender: DuckDBNativeAppender | undefined;
            const closeAppender = async () => {
              const owned = appender;
              appender = undefined;
              if (!owned) return;
              try {
                await owned.close();
              } catch (error) {
                current.broken = true;
                throw error;
              }
            };
            const staging = `__typed_sql_append_${randomUUID().replaceAll("-", "")}`;
            const quotedStage = duckdbRenderer.quoteIdentifier(staging);
            const table = target.table.map(duckdbRenderer.quoteIdentifier).join(".");
            const selected = target.columns.map(duckdbRenderer.quoteIdentifier).join(", ");
            try {
              ensure(local);
              await verifyConnection();
              if (!connection.createAppender)
                throw new TypeError("DuckDB connection has no native appender capability");
              await runControlledExecution(
                controls,
                async () => {
                  let native: DuckDBNativeStatement | undefined;
                  try {
                    native = await connection.prepare(initial.text);
                    verifyParameters(native, initial.bindings);
                  } finally {
                    await cleanup(undefined, native, false);
                  }
                  await control(`CREATE TEMP TABLE ${quotedStage} AS SELECT ${selected} FROM ${table} LIMIT 0`);
                  appender = await connection.createAppender!(staging);
                  if (
                    appender.columns.length !== initial.bindings.length ||
                    appender.columns.some(
                      (type, i) => formatDuckDBType(type) !== formatDuckDBType(initial.bindings[i]!.type),
                    )
                  )
                    throw new TypeError("DuckDB appender native column metadata differs from compiled targets");
                  for await (const rows of chunks) await appender.append(rows);
                  await closeAppender();
                  await control(`INSERT INTO ${table} (${selected}) SELECT ${selected} FROM ${quotedStage}`);
                  await control(`DROP TABLE ${quotedStage}`);
                },
                () => connection.interrupt?.(),
              );
            } finally {
              await closeAppender().catch(() => undefined);
              // The staging relation belongs to this transaction. A failed statement can abort
              // native SQL dispatch; rollback removes it without issuing cleanup SQL in that state.
              release();
            }
          };
          return scope ? append(scope) : transaction(undefined, append);
        });
      },
    });
    const trackedAppender: DuckDBAppenderCapability = {
      append: (factory, rows, controls) => {
        ensure(scope);
        return track(scope, () => appender.append(factory, rows, controls));
      },
    };
    return Object.freeze({
      [adapterCapabilities]: createAdapterCapabilityResolver(
        connection.createAppender ? [[duckdbAppender, trackedAppender]] : [],
      ),
      executionCapabilities: capabilities,
      all,
      execute: all,
      one: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
        run(query, controls, "one", (rows) => rows[0]!),
      maybeOne: <Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) =>
        run(query, controls, "maybeOne", (rows) => rows[0]),
      transaction<T>(callback: (database: DuckDBTransaction) => Promise<T>): Promise<T> {
        return observe(
          {
            kind: "transaction",
            dialect: "duckdb",
            grammarVersion: DUCKDB_DIALECT_VERSION,
            transactionDepth: scope ? 2 : 1,
          },
          () => transaction(scope, (local) => callback(makeScope(local))),
        );
      },
      batch: <const Queries extends readonly unknown[]>(
        queries: QueryBatch<Queries>,
      ): Promise<QueryResults<Queries>> => {
        let statements: readonly Ready[];
        try {
          statements = Array.from(queries, (query) => ready(query as Query<unknown>));
        } catch (error) {
          return track(scope, () => Promise.reject(error));
        }
        return track(scope, () =>
          observe(
            {
              kind: "batch",
              dialect: "duckdb",
              grammarVersion: DUCKDB_DIALECT_VERSION,
              transactionDepth: scope ? 1 : 0,
              size: statements.length,
              fingerprints: statements.map((statement) => fingerprint(statement.query)),
            },
            async () => {
              const run = async (local: Scope) => {
                const results = [];
                for (const statement of statements) results.push(await operation(statement, local));
                return results as QueryResults<Queries>;
              };
              return scope ? run(scope) : transaction(undefined, run);
            },
          ),
        );
      },
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
        const owner = {};
        const preparedFactory = registerPreparedQuery({
          state: registered,
          renderer: duckdbRenderer,
          statementName: name,
          factory,
          metadata: (variant) => ({ owner, statementName: name, rendered: variant.rendered }),
          capacity: { maximum: 128, message: "DuckDB prepared factory limit" },
        });
        preparedOwners.set(name, owner);
        const owned = (...args: Args) => {
          ensure(scope);
          if (preparedOwners.get(name) !== owner) throw new Error("DuckDB prepared factory has been retired");
          return preparedFactory(...args);
        };
        return Object.freeze(Object.assign(owned, { statementName: name }));
      },
      unprepare(name: string): Promise<void> {
        return track(scope, async () => {
          if (typeof name !== "string" || !name || name.includes("\0"))
            throw new TypeError("Invalid DuckDB prepared statement name");
          const release = await acquire(scope);
          try {
            ensure(scope);
            registered.statements.delete(name);
            preparedOwners.delete(name);
            let failure: unknown,
              failed = false;
            for (const [key, handle] of nativePrepared)
              if (key.startsWith(`${name}\0`)) {
                nativePrepared.delete(key);
                try {
                  await cleanup(undefined, handle, false);
                } catch (error) {
                  if (!failed) failure = error;
                  failed = true;
                }
              }
            if (failed) throw failure;
          } finally {
            release();
          }
        });
      },
    });
  };
  const serviceTransport: DuckDBServiceTransport = {
    async lease(work) {
      const release = await acquire();
      try {
        ensure();
        await verifyConnection();
        return await work({
          async server() {
            if (!expectedEvidence) throw new TypeError("DuckDB services require native server evidence");
            return expectedEvidence;
          },
          async describe(text, work) {
            let native: DuckDBNativeStatement | undefined;
            let failed = true;
            try {
              native = await connection.prepare(text);
              const result = await work(native);
              failed = false;
              return result;
            } finally {
              await cleanup(undefined, native, failed);
            }
          },
          async rows(text, bindings = []) {
            let native: DuckDBNativeStatement | undefined, result: DuckDBNativeResult | undefined;
            let failed = true;
            try {
              native = await connection.prepare(text);
              verifyParameters(native, bindings);
              result = await native.execute(bindings);
              // Own rows before releasing the native result. Service queries use scalar catalog/JSON data.
              const rows = await result.readAll();
              const owned = rows.map((row) =>
                row.map((value, i) =>
                  decodeDuckDBValue(value, result!.columns[i]!.type, { ...policy, json: "string" }, "service evidence"),
                ),
              );
              failed = false;
              return owned;
            } finally {
              await cleanup(result, native, failed);
            }
          },
        });
      } finally {
        release();
      }
    },
  };
  const root = makeScope();
  return Object.freeze({
    ...root,
    liveVerifier: createDuckDBLiveVerifier(serviceTransport, policy, typePolicyHash),
    planInspector: createDuckDBPlanInspector(serviceTransport, policy),
    evidence: Object.freeze({ libraryVersion: connection.libraryVersion, typePolicyHash }),
    queryable: Object.freeze({
      async all<Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<readonly Row[]> {
        const release = await acquire();
        let statement: DuckDBNativeStatement | undefined, result: DuckDBNativeResult | undefined;
        let failed = true;
        try {
          ensure();
          await verifyConnection();
          statement = await connection.prepare(text);
          result = await statement.execute(
            values.map((value) => {
              if (typeof value !== "string")
                throw new TypeError("DuckDB catalog queryable accepts text parameters only");
              return { type: { kind: "scalar" as const, name: "VARCHAR" }, value };
            }),
          );
          columns(result);
          const rows = decode(await result.readAll(), result.columns) as Row[];
          failed = false;
          return rows;
        } finally {
          try {
            await cleanup(result, statement, failed);
          } finally {
            release();
          }
        }
      },
    }),
    async close() {
      if (closed) return;
      if (current.transaction) throw new Error("Cannot close DuckDB during an active transaction");
      const release = await current.queue.acquire();
      try {
        if (closed) return;
        closed = true;
        let failure: unknown,
          failed = false;
        const retire = async (close: () => void | Promise<void>) => {
          try {
            await close();
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
            current.broken = true;
          }
        };
        for (const handle of nativePrepared.values()) await retire(() => handle.close());
        nativePrepared.clear();
        registered.statements.clear();
        preparedOwners.clear();
        if (options.ownsConnection) {
          await retire(() => connection.close?.());
          current.dead = true;
        }
        if (failed) throw failure;
      } finally {
        release();
      }
    },
  });
}
