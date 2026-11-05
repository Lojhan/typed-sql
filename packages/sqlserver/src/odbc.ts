import { createRequire } from "node:module";
import { type ExecutionOptions, runControlledExecution } from "@typed-sql/core";
import type { SchemaProvider, SchemaSnapshotV2 } from "@typed-sql/schema";
import { assertSqlServerRuntimeEvidence } from "./capabilities.js";
import {
  readSqlServerServerEvidence,
  SqlServerSchemaProvider,
  type SqlServerSchemaProviderOptions,
} from "./provider.js";
import {
  createSqlServerDatabase,
  type SqlServerConnectionLike,
  type SqlServerDatabase,
  type SqlServerDatabaseOptions,
  type SqlServerExecutionResult,
  type SqlServerField,
  type SqlServerNativePrepared,
  type SqlServerProtocolStream,
  withSqlServerInitializationLease,
} from "./runtime.js";
import { sqlServerVersionSupport } from "./support.js";
export interface SqlServerOdbcMetadata {
  readonly name: string;
  readonly nullable?: boolean;
  readonly sqlType?: string;
  readonly size?: number;
  readonly precision?: number;
  readonly scale?: number;
}
export interface SqlServerOdbcQuery {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, handler: (...args: unknown[]) => void): unknown;
  isPrepared(): boolean;
  cancelQuery(callback?: (error?: unknown) => void): void;
  pauseQuery(): void;
  resumeQuery(): void;
}
export interface SqlServerOdbcPrepared {
  preparedQuery(values: readonly unknown[]): SqlServerOdbcQuery;
  free(callback: (error?: unknown) => void): void;
  getMeta(): readonly SqlServerOdbcMetadata[];
}
export interface SqlServerOdbcConnection {
  queryRaw(
    query: { readonly query_str: string; readonly numeric_string: true },
    values: readonly unknown[],
  ): SqlServerOdbcQuery;
  prepare(
    query: { readonly query_str: string; readonly numeric_string: true },
    callback: (error: unknown, statement: SqlServerOdbcPrepared) => void,
  ): void;
  setUseUTC(enabled: boolean): void;
  setUseNumericString(enabled: boolean): void;
  setMaxPreparedColumnSize(bytes: number): void;
  readonly promises: { close(): Promise<void> };
}
export interface SqlServerOdbcDriver {
  readonly promises: {
    open(options: { readonly conn_str: string; readonly conn_timeout?: number }): Promise<SqlServerOdbcConnection>;
  };
  NVarChar(value: string | null): unknown;
  VarBinary(value: Uint8Array | null): unknown;
  Double(value: number): unknown;
  Bit(value: boolean): unknown;
}
export interface SqlServerOdbcOptions
  extends Omit<SqlServerDatabaseOptions, "connection" | "ownsConnection" | "serverEvidence"> {
  readonly connectionString?: string | (() => string | Promise<string>);
  readonly connection?: SqlServerOdbcConnection;
  readonly ownsConnection?: boolean;
  readonly connectionTimeoutSeconds?: number;
  /** Explicit native loading seam; applications normally install msnodesqlv8 and omit this. */
  readonly driverImporter?: () => Promise<SqlServerOdbcDriver>;
  readonly driverVersion?: string;
  /** Owned sessions are configured by default; injected sessions are only validated unless explicitly enabled. */
  readonly configureSession?: boolean;
}
interface NativeRequest {
  readonly query: SqlServerOdbcQuery;
  readonly fields: Promise<readonly SqlServerField[]>;
  readonly completion: Promise<SqlServerExecutionResult>;
  readonly state: { reusable: boolean; settled: boolean };
}
function field(value: SqlServerOdbcMetadata): SqlServerField {
  return {
    name: value.name,
    ...(value.precision === undefined ? {} : { precision: value.precision }),
    ...(value.scale === undefined ? {} : { scale: value.scale }),
    ...(value.sqlType ? { databaseType: value.sqlType } : {}),
    ...(typeof value.nullable === "boolean" ? { nullable: value.nullable } : {}),
  };
}
/** Observe raw native tokens so duplicate column names, truncation and late errors cannot disappear. */
function request(query: SqlServerOdbcQuery, onRow?: (row: Readonly<Record<string, unknown>>) => void): NativeRequest {
  let resolveFields!: (fields: readonly SqlServerField[]) => void, rejectFields!: (error: unknown) => void;
  const fieldsPromise = new Promise<readonly SqlServerField[]>((resolve, reject) => {
    resolveFields = resolve;
    rejectFields = reject;
  });
  void fieldsPromise.catch(() => {});
  let resolveCompletion!: (result: SqlServerExecutionResult) => void, rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<SqlServerExecutionResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => {});
  const rows: Readonly<Record<string, unknown>>[] = [];
  let fields: readonly SqlServerField[] = [];
  let row: unknown[] = [];
  let sets = 0;
  let error: unknown;
  let done = false;
  const warnings: { code?: string; message?: string }[] = [];
  const state = { reusable: true, settled: false };
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const listen = (event: string, handler: (...args: unknown[]) => void) => {
    const guarded = (...args: unknown[]) => {
      try {
        handler(...args);
      } catch (failure) {
        error ??= failure;
        try {
          query.cancelQuery((cancelError) => {
            if (cancelError) state.reusable = false;
          });
        } catch {
          state.reusable = false;
        }
      }
    };
    listeners.set(event, guarded);
    query.on(event, guarded);
  };
  const settle = () => {
    if (state.settled) return;
    state.settled = true;
    if (!sets) resolveFields([]);
    for (const [event, handler] of listeners) query.removeListener?.(event, handler);
    if (error) {
      rejectFields(error);
      rejectCompletion(error);
    } else resolveCompletion({ rows, fields, resultSets: sets, warnings });
  };
  listen("meta", (value) => {
    if (!Array.isArray(value)) {
      error ??= new TypeError("Native ODBC metadata must be an array");
      return;
    }
    const metadata = value as unknown as readonly SqlServerOdbcMetadata[];
    sets++;
    if (sets === 1) {
      fields = metadata.map(field);
      const names = new Set<string>();
      for (const item of fields) {
        if (!item.name || names.has(item.name))
          error ??= new TypeError("SQL Server native columns must have unique nonempty names");
        names.add(item.name);
      }
      resolveFields(fields);
    } else error ??= new TypeError("SQL Server query returned multiple result sets");
  });
  listen("row", () => {
    row = [];
  });
  listen("column", (index, value) => {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= fields.length) {
      error ??= new TypeError("Invalid ODBC column index");
      return;
    }
    row[index] = value;
    if (index === fields.length - 1 && !error) {
      const object = Object.fromEntries(fields.map((item, position) => [item.name, row[position]]));
      if (onRow) onRow(object);
      else rows.push(object);
    }
  });
  listen("error", (value) => {
    error ??= value;
    if (
      typeof value === "object" &&
      value !== null &&
      "sqlstate" in value &&
      typeof value.sqlstate === "string" &&
      value.sqlstate.startsWith("08")
    )
      state.reusable = false;
  });
  listen("info", (value) => {
    const info =
      typeof value === "object" && value !== null ? (value as { sqlstate?: unknown; message?: unknown }) : {};
    const code = typeof info.sqlstate === "string" ? info.sqlstate : undefined;
    warnings.push({
      ...(code ? { code } : {}),
      ...(typeof info.message === "string" ? { message: info.message } : {}),
    });
    if (code === "01004") error ??= new RangeError("Native SQL Server transport truncated a value");
  });
  listen("done", () => {
    done = true;
    if (query.isPrepared()) settle();
  });
  listen("free", () => {
    if (!done && !error) error = new Error("Native SQL Server request released before completion");
    settle();
  });
  return { query, fields: fieldsPromise, completion, state };
}
function cancelled(request: NativeRequest): void {
  if (request.state.settled) return;
  try {
    request.query.cancelQuery((error) => {
      if (error) request.state.reusable = false;
    });
  } catch {
    request.state.reusable = false;
  }
}
function nativeBindings(driver: SqlServerOdbcDriver, values: readonly unknown[]): unknown[] {
  return values.map((value) => {
    if (value === null || typeof value === "string") return driver.NVarChar(value);
    if (typeof value === "boolean") return driver.Bit(value);
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    )
      return driver.Double(value);
    if (typeof value === "bigint") return driver.NVarChar(value.toString());
    if (value instanceof Uint8Array) return driver.VarBinary(value.slice());
    throw new TypeError("Unsupported raw ODBC binding");
  });
}
const adapted = new WeakMap<
  SqlServerOdbcConnection,
  { driver: SqlServerOdbcDriver; connection: SqlServerConnectionLike }
>();
export function adaptSqlServerOdbcConnection(
  driver: SqlServerOdbcDriver,
  native: SqlServerOdbcConnection,
): SqlServerConnectionLike {
  const cached = adapted.get(native);
  if (cached) {
    if (cached.driver !== driver)
      throw new TypeError("An ODBC connection cannot be adapted with conflicting native drivers");
    return cached.connection;
  }
  let reusable = true;
  const connection: SqlServerConnectionLike = Object.freeze({
    executionCapabilities: Object.freeze({ cancellation: true, deadlines: true }),
    async execute(text: string, values: readonly unknown[] = [], controls: ExecutionOptions = {}) {
      if (!reusable) throw new Error("Native SQL Server connection is quarantined");
      let operation: NativeRequest | undefined;
      try {
        return await runControlledExecution(
          controls,
          async () => {
            operation = request(
              native.queryRaw({ query_str: text, numeric_string: true }, nativeBindings(driver, values)),
            );
            return operation.completion;
          },
          () => {
            if (operation) cancelled(operation);
          },
        );
      } finally {
        if (operation?.state.reusable === false) reusable = false;
      }
    },
    async prepare(text: string): Promise<SqlServerNativePrepared> {
      if (!reusable) throw new Error("Native SQL Server connection is quarantined");
      const statement = await new Promise<SqlServerOdbcPrepared>((resolve, reject) =>
        native.prepare({ query_str: text, numeric_string: true }, (error, value) =>
          error ? reject(error) : resolve(value),
        ),
      );
      let closed = false,
        running = false;
      return Object.freeze({
        async execute(values: readonly unknown[], controls: ExecutionOptions = {}) {
          if (!reusable) throw new Error("Native SQL Server connection is quarantined");
          if (closed || running) throw new Error("Native SQL Server prepared statement is closed or busy");
          running = true;
          let operation: NativeRequest | undefined;
          try {
            return await runControlledExecution(
              controls,
              async () => {
                operation = request(statement.preparedQuery(nativeBindings(driver, values)));
                return operation.completion;
              },
              () => {
                if (operation) cancelled(operation);
              },
            );
          } finally {
            if (operation?.state.reusable === false) reusable = false;
            running = false;
          }
        },
        async close() {
          if (closed) return;
          if (running) throw new Error("Cannot free an active SQL Server prepared statement");
          closed = true;
          await new Promise<void>((resolve, reject) => statement.free((error) => (error ? reject(error) : resolve())));
        },
      });
    },
    stream(text: string, values: readonly unknown[], options: { readonly batchSize: number }): SqlServerProtocolStream {
      if (!reusable) throw new Error("Native SQL Server connection is quarantined");
      const queue: Readonly<Record<string, unknown>>[] = [];
      let wake: (() => void) | undefined;
      let error: unknown,
        complete = false,
        closing: Promise<void> | undefined;
      let paused = false;
      const operation = request(
        native.queryRaw({ query_str: text, numeric_string: true }, nativeBindings(driver, values)),
        (row) => {
          queue.push(row);
          if (queue.length >= options.batchSize && !paused) {
            paused = true;
            operation.query.pauseQuery();
          }
          wake?.();
          wake = undefined;
        },
      );
      void operation.completion.then(
        () => {
          complete = true;
          wake?.();
          wake = undefined;
        },
        (failure) => {
          error = failure;
          complete = true;
          queue.length = 0;
          wake?.();
          wake = undefined;
        },
      );
      const stream: SqlServerProtocolStream = {
        fields: operation.fields,
        get connectionReusable() {
          return operation.state.reusable;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          for (;;) {
            if (error) throw error;
            if (queue.length) {
              const row = queue.shift()!;
              if (paused && queue.length < Math.max(1, Math.floor(options.batchSize / 2))) {
                paused = false;
                operation.query.resumeQuery();
              }
              return { done: false, value: row };
            }
            if (complete) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
        return() {
          return this.close().then(() => ({ done: true as const, value: undefined }));
        },
        async close() {
          if (closing) return closing;
          closing = (async () => {
            queue.length = 0;
            if (!complete) cancelled(operation);
            await operation.completion.catch(() => {});
            complete = true;
            wake?.();
            wake = undefined;
          })();
          return closing;
        },
      };
      return stream;
    },
    close: () => native.promises.close(),
  });
  adapted.set(native, { driver, connection });
  return connection;
}
export async function loadSqlServerOdbcDriver(
  importer?: () => Promise<SqlServerOdbcDriver>,
): Promise<SqlServerOdbcDriver> {
  if (importer) return importer();
  try {
    const packageName = "msnodesqlv8";
    const loaded = (await import(packageName)) as { default?: SqlServerOdbcDriver } & Partial<SqlServerOdbcDriver>;
    return (loaded.default ?? loaded) as SqlServerOdbcDriver;
  } catch (error) {
    throw new Error(
      "@typed-sql/sqlserver/odbc requires the application-owned msnodesqlv8 driver and Microsoft ODBC Driver18; install them explicitly",
      { cause: error },
    );
  }
}
const configuredPreparedLimits = new WeakMap<SqlServerOdbcConnection, number>();
export async function createSqlServerOdbcDatabase(options: SqlServerOdbcOptions): Promise<SqlServerDatabase> {
  const driver = await loadSqlServerOdbcDriver(options.driverImporter);
  const version =
    options.driverVersion ??
    (!options.driverImporter
      ? String((createRequire(import.meta.url)("msnodesqlv8/package.json") as { version: unknown }).version)
      : undefined);
  if (!version || (!/^6\.(?:[3-9]|[1-9]\d)\.\d+$/u.test(version) && !/^6\.2\.(?:[2-9]|[1-9]\d)$/u.test(version)))
    throw new TypeError("Exact SQL Server ODBC transport requires qualified msnodesqlv8 >=6.2.2 <7");
  const owns = options.connection ? options.ownsConnection === true : true;
  let native = options.connection;
  if (!native) {
    const connectionString =
      typeof options.connectionString === "function" ? await options.connectionString() : options.connectionString;
    if (!connectionString) throw new TypeError("SQL Server ODBC requires an injected connection or connectionString");
    native = await driver.promises.open({
      conn_str: connectionString,
      ...(options.connectionTimeoutSeconds === undefined ? {} : { conn_timeout: options.connectionTimeoutSeconds }),
    });
  }
  try {
    const maximum = options.maximumPreparedValueBytes ?? 1024 * 1024;
    const configured = configuredPreparedLimits.get(native);
    if (configured !== undefined && configured !== maximum)
      throw new TypeError("An ODBC connection cannot use conflicting prepared buffer limits");
    const connection = adaptSqlServerOdbcConnection(driver, native);
    const serverEvidence = await withSqlServerInitializationLease(connection, async () => {
      native.setUseUTC(true);
      native.setUseNumericString(true);
      native.setMaxPreparedColumnSize(maximum);
      configuredPreparedLimits.set(native, maximum);
      const client = {
        async all<Row extends Record<string, unknown>>(text: string): Promise<readonly Row[]> {
          return (await connection.execute(text)).rows as readonly Row[];
        },
      };
      let { server } = await readSqlServerServerEvidence(client);
      if (
        typeof server.settings.compatibilityLevel !== "number" ||
        sqlServerVersionSupport(server.version, server.settings.compatibilityLevel) !== "supported" ||
        ![1, 2, 3, 4].includes(Number(server.settings.engineEdition))
      )
        throw new TypeError(
          "SQL Server native runtime requires a qualified boxed server build and compatibility level",
        );
      if (options.configureSession === true || (!options.connection && options.configureSession !== false)) {
        await connection.execute(
          "SET QUOTED_IDENTIFIER ON; SET ANSI_WARNINGS ON; SET ARITHABORT ON; SET CONCAT_NULL_YIELDS_NULL ON; SET LANGUAGE us_english; SET DATEFORMAT mdy; SET DATEFIRST 7",
        );
        server = (await readSqlServerServerEvidence(client)).server;
      }
      assertSqlServerRuntimeEvidence(server);
      return server;
    });
    return createSqlServerDatabase({ ...options, connection, ownsConnection: owns, serverEvidence });
  } catch (error) {
    if (owns) await native.promises.close().catch(() => {});
    throw error;
  }
}

export interface SqlServerOdbcSchemaProviderOptions extends SqlServerOdbcOptions {
  readonly includeSchemas?: SqlServerSchemaProviderOptions["includeSchemas"];
}
/** Lazily load the explicit native driver only when introspection is requested. */
export function sqlServerOdbc(options: SqlServerOdbcSchemaProviderOptions = {}): SchemaProvider<SchemaSnapshotV2> {
  return {
    async introspect(input) {
      const database = await createSqlServerOdbcDatabase({
        ...options,
        ...(!options.connectionString && input.url ? { connectionString: input.url } : {}),
      });
      try {
        return await new SqlServerSchemaProvider({
          client: database.queryable,
          ...(options.includeSchemas ? { includeSchemas: options.includeSchemas } : {}),
          ...(options.typePolicy ? { typePolicy: options.typePolicy } : {}),
        }).introspect(input);
      } finally {
        await database.close();
      }
    },
  };
}
