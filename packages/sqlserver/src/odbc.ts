import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { type ExecutionOptions, runControlledExecution } from "@typed-sql/core";
import type { SchemaProvider, SchemaSnapshotV2 } from "@typed-sql/schema";
import { assertSqlServerRuntimeEvidence } from "./capabilities.js";
import { requireSqlServerNativeType } from "./native-types.js";
import { requireSqlServerKoffi } from "./odbc-native.js";
import {
  type OdbcBoundValue,
  type OdbcColumn,
  type OdbcCommand,
  type OdbcReply,
  type OdbcResult,
  type OdbcWorkerOptions,
  odbcPositiveInteger,
  odbcState,
  ODBC_STATE as S,
} from "./odbc-protocol.js";
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
export interface SqlServerOdbcOptions
  extends Omit<SqlServerDatabaseOptions, "connection" | "ownsConnection" | "serverEvidence"> {
  readonly connectionString?: string | (() => string | Promise<string>);
  /** Application-owned Koffi loading seam. Workers resolve the same installed module by driverModulePath. */
  readonly driverImporter?: () => Promise<unknown>;
  readonly driverModulePath?: string;
  readonly libraryPath?: string;
  readonly connectionTimeoutSeconds?: number;
  readonly queryTimeoutSeconds?: number;
  readonly maximumCellBytes?: number;
  readonly maximumResultBytes?: number;
  readonly maximumRows?: number;
  readonly chunkBytes?: number;
  readonly configureSession?: boolean;
}
export type { SqlServerKoffi } from "./odbc-native.js";
export async function loadSqlServerOdbcDriver(importer?: () => Promise<unknown>) {
  const application = createRequire(resolve(process.cwd(), "package.json"));
  return requireSqlServerKoffi(importer ? await importer() : application("koffi"));
}
export function sqlServerOdbcField(column: OdbcColumn): SqlServerField {
  const base = requireSqlServerNativeType(column.typeName),
    name = base.name;
  let text = base.text;
  if (["varchar", "nvarchar", "char", "nchar", "binary", "varbinary"].includes(name)) {
    const bound = name.startsWith("n") ? 4000 : 8000,
      length = column.size === 0 || column.size > bound ? "max" : column.size;
    text = requireSqlServerNativeType(`${name}(${length})`).text;
  } else if (name === "decimal") text = requireSqlServerNativeType(`decimal(${column.size},${column.scale})`).text;
  else if (["time", "datetime2", "datetimeoffset"].includes(name))
    text = requireSqlServerNativeType(`${name}(${column.scale})`).text;
  const target = requireSqlServerNativeType(text);
  return {
    name: column.name,
    databaseType: text,
    nullable: column.nullable,
    ...(target.length === undefined ? {} : { length: target.length }),
    ...(name === "decimal" ? { precision: target.precision!, scale: target.scale! } : {}),
    ...(["time", "datetime2", "datetimeoffset"].includes(name) ? { scale: target.scale! } : {}),
    ...(column.type === 12 && name === "varchar" && column.size === 0
      ? { wireType: "odbc-varchar-unlimited-text" as const }
      : {}),
  };
}
function bindings(values: readonly unknown[], maximum: number): readonly OdbcBoundValue[] {
  let bytes = 0;
  if (values.length > 2100) throw new RangeError("SQL Server supports at most2100 parameters");
  return values.map((value) => {
    let result: OdbcBoundValue;
    if (value === null || typeof value === "string") result = value;
    else if (typeof value === "boolean") result = value ? "1" : "0";
    else if (typeof value === "bigint") result = value.toString();
    else if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    )
      result = String(value);
    else if (value instanceof Uint8Array) {
      if (bytes + value.byteLength > maximum)
        throw new RangeError("SQL Server bound values exceed the configured memory limit");
      result = Uint8Array.from(value);
    } else throw new TypeError("Unsupported direct ODBC bound value");
    bytes += typeof result === "string" ? result.length * 2 : (result?.byteLength ?? 0);
    if (bytes > maximum) throw new RangeError("SQL Server bound values exceed the configured memory limit");
    return result;
  });
}
function rows(result: OdbcResult): SqlServerExecutionResult {
  const fields = result.columns.map(sqlServerOdbcField);
  return {
    fields,
    resultSets: fields.length ? 1 : 0,
    rows: result.rows.map((values) => {
      if (values.length !== fields.length) throw new TypeError("Native ODBC row width disagrees with metadata");
      return Object.fromEntries(fields.map((field, index) => [field.name, values[index]]));
    }),
  };
}
type CommandBody = OdbcCommand extends infer Command
  ? Command extends OdbcCommand
    ? Omit<Command, "id">
    : never
  : never;
class SqlServerOdbcTransport {
  readonly state;
  readonly control: Worker;
  readonly data: Worker;
  readonly ready: Promise<void>;
  nextId = 1;
  busy = false;
  closed = false;
  reusable = true;
  cursor: number | undefined;
  private readonly acknowledgements = new Map<number, () => void>();
  private pending: { id: number; resolve(reply: OdbcReply): void; reject(error: unknown): void } | undefined;
  constructor(readonly options: OdbcWorkerOptions) {
    this.state = odbcState(options.shared);
    const sibling = new URL("./odbc-worker.js", import.meta.url),
      url = existsSync(sibling) ? sibling : new URL("../dist/packages/sqlserver/src/odbc-worker.js", import.meta.url);
    this.control = new Worker(url, { workerData: { role: "control", options } });
    this.data = new Worker(url, { workerData: { role: "data", options } });
    const start = (worker: Worker) =>
      new Promise<void>((resolve, reject) => {
        const listener = (message: { ready?: boolean; error?: unknown }) => {
          if (message.ready === undefined) return;
          worker.off("message", listener);
          if (message.ready) resolve();
          else reject(new Error("SQL Server ODBC worker initialization failed"));
        };
        worker.on("message", listener);
        worker.once("error", () => reject(new Error("SQL Server ODBC worker initialization failed")));
        worker.once("exit", (code) => {
          if (code !== 0) reject(new Error("SQL Server ODBC worker exited during initialization"));
        });
      });
    this.ready = Promise.all([start(this.control), start(this.data)]).then(() => {});
    void this.ready.catch(() => {
      this.reusable = false;
      this.control.postMessage({ kind: "close" });
      this.data.postMessage({ id: 0, kind: "close" });
      this.control.unref();
      this.data.unref();
    });
    this.data.on("message", (reply: OdbcReply) => {
      if (!Number.isInteger(reply.id) || reply.id !== this.pending?.id) return;
      const pending = this.pending;
      this.pending = undefined;
      if (reply.error) {
        if (!reply.error.reusable) this.reusable = false;
        const error = new Error(reply.error.message);
        Object.assign(error, {
          code: "TSQL_ODBC_NATIVE",
          stage: reply.error.stage,
          diagnostics: reply.error.diagnostics,
        });
        pending.reject(error);
      } else pending.resolve(reply);
    });
    this.control.on("message", (message: { ack?: number; failed?: boolean }) => {
      if (message.failed) this.reusable = false;
      if (message.ack !== undefined) {
        this.acknowledgements.get(message.ack)?.();
        this.acknowledgements.delete(message.ack);
      }
    });
    const failed = () => {
      this.reusable = false;
      Atomics.store(this.state.words, S.controlFailure, 1);
      Atomics.notify(this.state.words, S.ack);
      Atomics.notify(this.state.words, S.borrows);
      this.pending?.reject(new Error("SQL Server ODBC worker failed; connection quarantined"));
      this.pending = undefined;
      for (const resolve of this.acknowledgements.values()) resolve();
      this.acknowledgements.clear();
    };
    this.control.on("error", failed);
    this.data.on("error", failed);
    this.control.on("exit", () => {
      if (!this.closed) failed();
    });
    this.data.on("exit", () => {
      if (!this.closed) failed();
    });
  }
  async request(command: CommandBody, controls: ExecutionOptions = {}, cursor?: number): Promise<OdbcReply> {
    await this.ready;
    if (this.closed || (!this.reusable && !["close", "freePrepared", "streamClose"].includes(command.kind)))
      throw new Error("SQL Server direct ODBC connection is closed or quarantined");
    if (this.busy || (this.cursor !== undefined && this.cursor !== cursor))
      throw new Error("SQL Server direct ODBC connection is busy");
    if (this.nextId >= 0x7fffffff)
      throw new RangeError("SQL Server ODBC request epoch exhausted; recreate the connection");
    this.busy = true;
    const id = this.nextId++;
    try {
      return await runControlledExecution(
        controls,
        () =>
          new Promise<OdbcReply>((resolve, reject) => {
            this.pending = { id, resolve, reject };
            this.data.postMessage({ ...command, id });
          }),
        () => {
          Atomics.store(this.state.words, S.cancel, id);
          this.control.postMessage({ kind: "cancel", epoch: id });
        },
      );
    } finally {
      if (
        Atomics.load(this.state.words, S.cancel) === id &&
        Atomics.load(this.state.words, S.ack) !== id &&
        !Atomics.load(this.state.words, S.controlFailure)
      )
        await new Promise<void>((resolve) => {
          this.acknowledgements.set(id, resolve);
          if (Atomics.load(this.state.words, S.ack) === id) {
            this.acknowledgements.delete(id);
            resolve();
          }
        });
      this.busy = false;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.busy || this.cursor !== undefined) throw new Error("Cannot close an active direct ODBC connection");
    try {
      await this.request({ kind: "close" });
    } finally {
      this.closed = true;
      this.reusable = false;
      this.control.postMessage({ kind: "close" });
      this.control.unref();
      this.data.unref();
    }
  }
}
export async function connectSqlServerOdbc(options: SqlServerOdbcOptions): Promise<SqlServerConnectionLike> {
  for (const [name, value] of Object.entries({
    connectionTimeoutSeconds: options.connectionTimeoutSeconds ?? 15,
    queryTimeoutSeconds: options.queryTimeoutSeconds ?? 30,
    maximumCellBytes: options.maximumCellBytes ?? 16 * 1024 * 1024,
    maximumResultBytes: options.maximumResultBytes ?? 64 * 1024 * 1024,
    maximumRows: options.maximumRows ?? 100000,
    chunkBytes: options.chunkBytes ?? 4096,
  }))
    odbcPositiveInteger(value, name);
  const modulePath = options.driverModulePath ?? createRequire(resolve(process.cwd(), "package.json")).resolve("koffi");
  requireSqlServerKoffi(
    options.driverImporter ? await options.driverImporter() : createRequire(import.meta.url)(modulePath),
  );
  const connectionString =
    typeof options.connectionString === "function" ? await options.connectionString() : options.connectionString;
  if (!connectionString) throw new TypeError("SQL Server direct ODBC requires a connection string");
  const chunk = options.chunkBytes ?? 4096;
  if (chunk % 2 || chunk > 1024 * 1024) throw new RangeError("ODBC chunkBytes must be even and at most1MiB");
  const transport = new SqlServerOdbcTransport({
    modulePath,
    libraryPath: options.libraryPath ?? "libodbc.so.2",
    connectionString,
    shared: new SharedArrayBuffer(48),
    loginTimeoutSeconds: options.connectionTimeoutSeconds ?? 15,
    queryTimeoutSeconds: options.queryTimeoutSeconds ?? 30,
    maximumCellBytes: options.maximumCellBytes ?? 16 * 1024 * 1024,
    maximumResultBytes: options.maximumResultBytes ?? 64 * 1024 * 1024,
    maximumRows: options.maximumRows ?? 100000,
    chunkBytes: chunk,
  });
  await transport.ready;
  const connection: SqlServerConnectionLike = {
    executionCapabilities: { cancellation: true, deadlines: true },
    async readServerEvidence(controls = {}) {
      return (
        await readSqlServerServerEvidence({
          async all<Row extends Record<string, unknown>>(text: string) {
            return (await connection.execute(text, [], controls)).rows as readonly Row[];
          },
        })
      ).server;
    },
    async execute(text, values = [], controls = {}) {
      const result = await transport.request(
        { kind: "execute", text, values: bindings(values, transport.options.maximumResultBytes) },
        controls,
      );
      return rows(result.result!);
    },
    async prepare(text) {
      const reply = await transport.request({ kind: "prepare", text }),
        handle = reply.handle!;
      let closed = false,
        running = false;
      const prepared: SqlServerNativePrepared = {
        ...(reply.result ? { fields: reply.result.columns.map(sqlServerOdbcField) } : {}),
        async execute(values, controls = {}) {
          if (closed || running) throw new Error("Native ODBC prepared handle is closed or busy");
          running = true;
          try {
            return rows(
              (
                await transport.request(
                  { kind: "preparedExecute", handle, values: bindings(values, transport.options.maximumResultBytes) },
                  controls,
                )
              ).result!,
            );
          } finally {
            running = false;
          }
        },
        async close() {
          if (closed) return;
          if (running) throw new Error("Cannot close a running native ODBC prepared handle");
          closed = true;
          await transport.request({ kind: "freePrepared", handle });
        },
      };
      return prepared;
    },
    stream(text, values, streamOptions) {
      const cancellation = new AbortController();
      let active: Promise<OdbcReply> | undefined;
      let handle: number | undefined,
        done = false,
        ended = false,
        closing: Promise<void> | undefined;
      let queue: readonly Readonly<Record<string, unknown>>[] = [];
      const input = bindings(values, transport.options.maximumResultBytes);
      active = transport.request({ kind: "streamStart", text, values: input }, { signal: cancellation.signal });
      const opening = active.then((reply) => {
        handle = reply.handle!;
        transport.cursor = handle;
        return reply.result!.columns.map(sqlServerOdbcField);
      });
      const stream: SqlServerProtocolStream = {
        fields: opening,
        get connectionReusable() {
          return transport.reusable;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          try {
            await opening;
            if (done) return { done: true, value: undefined };
            if (!queue.length) {
              if (ended) return { done: true, value: undefined };
              active = transport.request(
                { kind: "streamNext", handle: handle!, batchSize: streamOptions.batchSize },
                { signal: cancellation.signal },
                handle,
              );
              const reply = await active;
              queue = rows(reply.result!).rows;
              if (reply.done) ended = true;
            }
            const value = queue[0];
            queue = queue.slice(1);
            return value === undefined ? { done: true, value: undefined } : { done: false, value };
          } catch (error) {
            if (done) return { done: true, value: undefined };
            throw error;
          }
        },
        return() {
          return this.close().then(() => ({ done: true as const, value: undefined }));
        },
        async close() {
          if (closing) return closing;
          closing = (async () => {
            done = true;
            cancellation.abort("SQL Server stream closed");
            await active?.catch(() => {});
            await opening.catch(() => {});
            if (handle !== undefined) {
              try {
                await transport.request({ kind: "streamClose", handle }, {}, handle);
              } finally {
                transport.cursor = undefined;
              }
            }
          })();
          return closing;
        },
      };
      return stream;
    },
    close: () => transport.close(),
  };
  return Object.freeze(connection);
}
export async function createSqlServerOdbcDatabase(options: SqlServerOdbcOptions): Promise<SqlServerDatabase> {
  const connection = await connectSqlServerOdbc(options);
  try {
    const serverEvidence = await withSqlServerInitializationLease(connection, async () => {
      const initial = await connection.readServerEvidence!();
      if (
        typeof initial.settings.compatibilityLevel !== "number" ||
        sqlServerVersionSupport(initial.version, initial.settings.compatibilityLevel) !== "supported" ||
        ![1, 2, 3, 4].includes(Number(initial.settings.engineEdition))
      )
        throw new TypeError("SQL Server direct ODBC requires a qualified boxed engine and compatibility level");
      if (options.configureSession !== false)
        await connection.execute(
          "SET QUOTED_IDENTIFIER ON; SET ANSI_WARNINGS ON; SET ARITHABORT ON; SET CONCAT_NULL_YIELDS_NULL ON; SET LANGUAGE us_english; SET DATEFORMAT mdy; SET DATEFIRST 7",
        );
      const evidence = await connection.readServerEvidence!();
      assertSqlServerRuntimeEvidence(evidence);
      return evidence;
    });
    return createSqlServerDatabase({ ...options, connection, ownsConnection: true, serverEvidence });
  } catch (error) {
    await connection.close?.().catch(() => {});
    throw error;
  }
}
export interface SqlServerOdbcSchemaProviderOptions extends SqlServerOdbcOptions {
  readonly includeSchemas?: SqlServerSchemaProviderOptions["includeSchemas"];
}
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
