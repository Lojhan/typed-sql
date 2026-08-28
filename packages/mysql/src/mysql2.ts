import type { Connection as CallbackConnection, Query as CallbackQuery } from "mysql2";
import type { FieldPacket, Pool, PoolConnection, PoolOptions } from "mysql2/promise";
import type { MySqlSchemaSnapshot } from "./index.js";
import { type MySqlQueryable, MySqlSchemaProvider } from "./provider.js";
import {
  createMySqlDatabase,
  type MySqlConnectionLike,
  type MySqlDatabase,
  type MySqlExecutionResult,
  type MySqlFieldLike,
  type MySqlPoolLike,
  type MySqlProtocolStream,
} from "./runtime.js";
import type { MySqlTypePolicy } from "./type-policy.js";

export interface MySql2Options {
  readonly connectionUri: string | (() => string | Promise<string>);
  readonly poolConfig?: Omit<
    PoolOptions,
    | "uri"
    | "supportBigNumbers"
    | "bigNumberStrings"
    | "decimalNumbers"
    | "dateStrings"
    | "jsonStrings"
    | "typeCast"
    | "rowsAsArray"
  >;
  readonly typePolicy?: MySqlTypePolicy;
  readonly decimal?: (value: string) => unknown;
  /** Test or host-injected loader. Applications normally leave this unset. */
  readonly driverImporter?: () => Promise<typeof import("mysql2/promise")>;
}

export interface MySql2SchemaProviderOptions {
  readonly connectionUri?: string | (() => string | Promise<string>);
  readonly client?: MySqlQueryable;
  readonly schemas?: readonly string[];
  readonly poolConfig?: Omit<PoolOptions, "uri">;
  readonly typePolicy?: MySqlTypePolicy;
  /** Test or host-injected loader. Applications normally leave this unset. */
  readonly driverImporter?: () => Promise<typeof import("mysql2/promise")>;
}

interface Executable {
  execute(sql: string, values?: readonly unknown[]): Promise<readonly [unknown, (readonly FieldPacket[])?]>;
  query(sql: string, values?: readonly unknown[]): Promise<readonly [unknown, (readonly FieldPacket[])?]>;
}

export async function loadMySql2Driver(
  importer: () => Promise<typeof import("mysql2/promise")> = () => import("mysql2/promise"),
): Promise<typeof import("mysql2/promise")> {
  try {
    return await importer();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "@typed-sql/mysql/mysql2 requires the application-owned mysql2 driver. Install it with: pnpm add mysql2",
        { cause: error },
      );
    }
    throw error;
  }
}

async function uri(value: MySql2Options["connectionUri"]): Promise<string> {
  const result = typeof value === "function" ? await value() : value;
  if (result.length === 0) throw new TypeError("MySQL connectionUri must not be empty");
  return result;
}

const managedPoolOptions = [
  "supportBigNumbers",
  "bigNumberStrings",
  "decimalNumbers",
  "dateStrings",
  "jsonStrings",
  "typeCast",
  "rowsAsArray",
] as const;

function validatePoolConfig(poolConfig: MySql2Options["poolConfig"]): void {
  if (poolConfig === undefined) return;
  const configured = poolConfig as Readonly<Record<string, unknown>>;
  for (const option of managedPoolOptions) {
    if (option in configured) {
      throw new TypeError(
        `@typed-sql/mysql/mysql2 owns poolConfig.${option} so decoded values match typePolicy; remove that option`,
      );
    }
  }
}

function fields(values: readonly FieldPacket[]): readonly MySqlFieldLike[] {
  return values.map((field) => ({
    name: field.name,
    columnType: field.columnType ?? field.type ?? 0,
    ...(field.columnLength === undefined && field.length === undefined
      ? {}
      : { columnLength: field.columnLength ?? field.length }),
  }));
}

async function execute(
  value: Executable,
  method: "execute" | "query",
  sql: string,
  values?: readonly unknown[],
): Promise<MySqlExecutionResult> {
  const [rows, metadata] = await value[method](sql, values);
  return {
    rows: rows as readonly Record<string, unknown>[] | Record<string, unknown>,
    ...(metadata === undefined || metadata.length === 0 ? {} : { fields: fields(metadata) }),
  };
}

function connectionAdapter(connection: PoolConnection): MySqlConnectionLike {
  const executable = connection as unknown as Executable;
  return {
    execute: (sql, values) => execute(executable, "execute", sql, values),
    stream: (sql, values, options) =>
      createMySql2ProtocolStream(
        connection.connection as unknown as CallbackConnection,
        sql,
        values,
        options.batchSize,
      ),
    query: (sql) => execute(executable, "query", sql),
    beginTransaction: () => connection.beginTransaction(),
    commit: () => connection.commit(),
    rollback: () => connection.rollback(),
    destroy: () => connection.destroy(),
    release: () => connection.release(),
  };
}

function createMySql2ProtocolStream(
  connection: CallbackConnection,
  sql: string,
  values: readonly unknown[],
  batchSize: number,
): MySqlProtocolStream {
  // mysql2's promise API buffers execute() results. Its public PoolConnection.connection is the
  // same callback connection, whose Execute command exposes the protocol-backed Readable while
  // retaining mysql2's per-connection prepared statement cache.
  const command = connection.execute(sql, values as never) as CallbackQuery;
  let resolveFields!: (value: readonly MySqlFieldLike[]) => void;
  let rejectFields!: (reason: unknown) => void;
  let fieldsSettled = false;
  const fieldMetadata = new Promise<readonly MySqlFieldLike[]>((resolve, reject) => {
    resolveFields = resolve;
    rejectFields = reject;
  });
  // A driver failure can happen before the runtime starts awaiting metadata.
  void fieldMetadata.catch(() => undefined);

  let resolveTerminal!: () => void;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  let protocolError: unknown;
  let connectionReusable = false;
  let terminalSettled = false;
  let readable: ReturnType<CallbackQuery["stream"]> | undefined;
  const settleTerminal = (reusable: boolean) => {
    if (terminalSettled) return;
    terminalSettled = true;
    connectionReusable = reusable;
    connection.removeListener("error", onConnectionError);
    connection.removeListener("end", onConnectionEnd);
    connection.removeListener("close", onConnectionEnd);
    resolveTerminal();
  };
  const onConnectionError = (error: unknown) => {
    protocolError ??= error;
    if (!fieldsSettled) {
      fieldsSettled = true;
      rejectFields(error);
    }
    readable?.destroy(error as Error);
    settleTerminal(false);
  };
  const onConnectionEnd = () => {
    const error = new Error("MySQL connection ended before the streaming command completed");
    protocolError ??= error;
    if (!fieldsSettled) {
      fieldsSettled = true;
      rejectFields(error);
    }
    readable?.destroy(error);
    settleTerminal(false);
  };
  connection.once("error", onConnectionError);
  connection.once("end", onConnectionEnd);
  connection.once("close", onConnectionEnd);
  command.once("fields", (value: readonly FieldPacket[] | undefined) => {
    if (fieldsSettled) return;
    fieldsSettled = true;
    resolveFields(value === undefined ? [] : fields(value));
  });
  command.once("error", (error: unknown) => {
    protocolError = error;
    if (!fieldsSettled) {
      fieldsSettled = true;
      rejectFields(error);
    }
  });
  command.once("end", () => {
    if (!fieldsSettled) {
      fieldsSettled = true;
      resolveFields([]);
    }
    settleTerminal(true);
  });

  readable = command.stream({ highWaterMark: batchSize });
  // Query.stream can destroy with an error before next() installs the async iterator's listener.
  // Keep the process safe while preserving the same error for fields/iteration/close.
  readable.on("error", () => undefined);
  const iterator = readable[Symbol.asyncIterator]() as AsyncIterableIterator<Record<string, unknown>>;
  let closePromise: Promise<void> | undefined;

  return {
    fields: fieldMetadata,
    get connectionReusable() {
      return connectionReusable;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => iterator.next(),
    close() {
      closePromise ??= (async () => {
        // Destroying this Readable stops delivery and resumes the socket. The independently attached
        // command listeners remain until the Execute command really ends, so the connection is never
        // released or reused while protocol packets are still arriving.
        if (!readable.destroyed) readable.destroy();
        await terminal;
        if (protocolError !== undefined) throw protocolError;
      })();
      return closePromise;
    },
  };
}

export function adaptMySql2Pool(pool: Pool): MySqlPoolLike {
  const executable = pool as unknown as Executable;
  return {
    executionCapabilities: Object.freeze({ cancellation: true, deadlines: true }),
    execute: (sql, values) => execute(executable, "execute", sql, values),
    async getConnection(): Promise<MySqlConnectionLike> {
      return connectionAdapter(await pool.getConnection());
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}

export async function createMySql2Database(options: MySql2Options): Promise<MySqlDatabase> {
  validatePoolConfig(options.poolConfig);
  const driver = await loadMySql2Driver(options.driverImporter);
  const pool = driver.createPool({
    ...options.poolConfig,
    uri: await uri(options.connectionUri),
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    jsonStrings: false,
    rowsAsArray: false,
  });
  return createMySqlDatabase({
    pool: adaptMySql2Pool(pool),
    ownsPool: true,
    ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
    ...(options.decimal === undefined ? {} : { decimal: options.decimal }),
  });
}

export function mysql2(options: MySql2SchemaProviderOptions): { introspect(): Promise<MySqlSchemaSnapshot> } {
  return {
    async introspect(): Promise<MySqlSchemaSnapshot> {
      if (options.client !== undefined) {
        return (await new MySqlSchemaProvider({
          client: options.client,
          ...(options.schemas === undefined ? {} : { includeSchemas: options.schemas }),
          ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
        }).introspect({})) as MySqlSchemaSnapshot;
      }
      if (options.connectionUri === undefined)
        throw new TypeError("mysql2 schema provider requires connectionUri or client");
      const driver = await loadMySql2Driver(options.driverImporter);
      const pool = driver.createPool({ ...options.poolConfig, uri: await uri(options.connectionUri) });
      const executable = pool as unknown as Executable;
      const client: MySqlQueryable = {
        async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
          const result = await execute(executable, "query", sql, values);
          return { rows: (Array.isArray(result.rows) ? result.rows : []) as readonly Row[] };
        },
      };
      try {
        return (await new MySqlSchemaProvider({
          client,
          ...(options.schemas === undefined ? {} : { includeSchemas: options.schemas }),
          ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
        }).introspect({})) as MySqlSchemaSnapshot;
      } finally {
        await pool.end();
      }
    },
  };
}
