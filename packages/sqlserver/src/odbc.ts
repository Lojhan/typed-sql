import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { SchemaProvider, SchemaSnapshotV2 } from "@typed-sql/schema";
import { assertSqlServerRuntimeEvidence } from "./capabilities.js";
import { requireSqlServerNativeType } from "./native-types.js";
import {
  assertSqlServerOdbcFamily,
  type OdbcAliasRegistry,
  sqlServerOdbcAlias,
  sqlServerOdbcAliasQuery,
  sqlServerOdbcAliasRegistry,
} from "./odbc-aliases.js";
import { requireSqlServerKoffi } from "./odbc-native.js";
import {
  type OdbcBoundValue,
  type OdbcColumn,
  type OdbcReply,
  type OdbcResult,
  odbcPositiveInteger,
} from "./odbc-protocol.js";
import { SqlServerOdbcTransport } from "./odbc-transport.js";
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
  validateSqlServerResultFields,
  validateSqlServerRuntimeOptions,
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
export function sqlServerOdbcField(column: OdbcColumn, aliases: OdbcAliasRegistry = new Map()): SqlServerField {
  const alias = sqlServerOdbcAlias(column, aliases);
  if (alias) column = { ...column, typeName: alias.baseName };
  // SQLGetTypeInfo represents IDENTITY as a type attribute; it is not part of the value's SQL target.
  // Only normalize the exact qualified spelling when the independently reported ODBC code agrees.
  const identity = /^(bigint|int|smallint|tinyint|decimal|numeric) identity$/iu.exec(column.typeName);
  let typeName = column.typeName;
  if (identity) {
    const underlying = identity[1]!.toLowerCase(),
      codes: Readonly<Record<string, readonly number[]>> = {
        bigint: [-5],
        int: [4],
        smallint: [5],
        tinyint: [-6],
        decimal: [2, 3],
        numeric: [2, 3],
      };
    if (!codes[underlying]!.includes(column.type) || column.scale !== 0)
      throw new TypeError("SQL Server IDENTITY metadata disagrees with its native ODBC value family");
    typeName = underlying;
  }
  const base = requireSqlServerNativeType(typeName),
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
  assertSqlServerOdbcFamily(column, target.name);
  if (alias && target.text !== alias.databaseType)
    throw new TypeError("SQL Server alias dimensions disagree with verified native catalog metadata");
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
function rows(result: OdbcResult, aliases: OdbcAliasRegistry): SqlServerExecutionResult {
  const fields = result.columns.map((column) => sqlServerOdbcField(column, aliases));
  return {
    fields,
    resultSets: fields.length ? 1 : 0,
    rows: result.rows.map((values) => {
      if (values.length !== fields.length) throw new TypeError("Native ODBC row width disagrees with metadata");
      return Object.fromEntries(fields.map((field, index) => [field.name, values[index]]));
    }),
  };
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
  return createSqlServerOdbcConnection(transport);
}
/** Internal protocol composition seam; public entrypoints expose only the factory. */
export function createSqlServerOdbcConnection(transport: SqlServerOdbcTransport): SqlServerConnectionLike {
  let observedVersion: string | undefined;
  let aliases: OdbcAliasRegistry = new Map();
  const field = (column: OdbcColumn) => sqlServerOdbcField(column, aliases);
  const connection: SqlServerConnectionLike = {
    executionCapabilities: { cancellation: true, deadlines: true },
    validatePreparedMetadata: true,
    preparedControls: true,
    async readServerEvidence(controls = {}) {
      if (transport.busy || transport.cursor !== undefined)
        throw new Error("SQL Server alias attestation requires an idle native connection");
      aliases = new Map();
      const evidence = (
        await readSqlServerServerEvidence({
          async all<Row extends Record<string, unknown>>(text: string) {
            return (await connection.execute(text, [], controls)).rows as readonly Row[];
          },
        })
      ).server;
      observedVersion = evidence.versionKey;
      // Initial owned connections may still need the authorized canonical SET preset.
      // Invalid/changed sessions never expose an old database's alias registry.
      try {
        assertSqlServerRuntimeEvidence(evidence);
      } catch {
        return evidence;
      }
      const catalog = await connection.execute(sqlServerOdbcAliasQuery, [], controls);
      aliases = sqlServerOdbcAliasRegistry(catalog.rows);
      return evidence;
    },
    async execute(text, values = [], controls = {}) {
      const result = await transport.request(
        { kind: "execute", text, values: bindings(values, transport.options.maximumResultBytes) },
        controls,
      );
      return rows(result.result!, aliases);
    },
    async prepare(text, controls = {}) {
      const reply = await transport.request({ kind: "prepare", text }, controls),
        handle = reply.handle!;
      let closed = false,
        running = false;
      let fields: readonly SqlServerField[] | undefined;
      try {
        fields = reply.result?.columns.map(field);
      } catch (error) {
        try {
          await transport.request({ kind: "freePrepared", handle });
        } catch {
          transport.reusable = false;
        }
        throw error;
      }
      const prepared: SqlServerNativePrepared = {
        ...(fields ? { fields } : {}),
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
              aliases,
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
      let queueIndex = 0;
      const input = bindings(values, transport.options.maximumResultBytes);
      const opening = (async () => {
        if (streamOptions.valuePlan) {
          active = transport.request({ kind: "prepare", text }, { signal: cancellation.signal });
          const prepared = await active;
          handle = prepared.handle!;
          transport.cursor = handle;
          if (prepared.result)
            validateSqlServerResultFields(
              streamOptions.valuePlan,
              prepared.result.columns.map(field),
              observedVersion === "17",
            );
        }
        active = transport.request(
          { kind: "streamStart", text, values: input, ...(handle === undefined ? {} : { handle }) },
          { signal: cancellation.signal },
          handle,
        );
        const reply = await active;
        handle = reply.handle!;
        transport.cursor = handle;
        return reply.result!.columns.map(field);
      })();
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
            if (queueIndex >= queue.length) {
              if (ended) return { done: true, value: undefined };
              active = transport.request(
                { kind: "streamNext", handle: handle!, batchSize: streamOptions.batchSize },
                { signal: cancellation.signal },
                handle,
              );
              const reply = await active;
              queue = rows(reply.result!, aliases).rows;
              queueIndex = 0;
              if (reply.done) ended = true;
            }
            const value = queue[queueIndex++];
            if (queueIndex >= queue.length) {
              queue = [];
              queueIndex = 0;
            }
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
            queue = [];
            queueIndex = 0;
            cancellation.abort("SQL Server stream closed");
            await active?.catch(() => {});
            queue = [];
            queueIndex = 0;
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
  validateSqlServerRuntimeOptions(options);
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
