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
} from "./runtime.js";
import type { MySqlTypePolicy } from "./type-policy.js";

export interface MySql2Options {
  readonly connectionUri: string | (() => string | Promise<string>);
  readonly poolConfig?: Omit<PoolOptions, "uri">;
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
  execute(sql: string, values?: readonly unknown[]): Promise<readonly [unknown, readonly FieldPacket[]]>;
  query(sql: string, values?: readonly unknown[]): Promise<readonly [unknown, readonly FieldPacket[]]>;
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
    ...(metadata.length === 0 ? {} : { fields: fields(metadata) }),
  };
}

function connectionAdapter(connection: PoolConnection): MySqlConnectionLike {
  const executable = connection as unknown as Executable;
  return {
    execute: (sql, values) => execute(executable, "execute", sql, values),
    query: (sql) => execute(executable, "query", sql),
    beginTransaction: () => connection.beginTransaction(),
    commit: () => connection.commit(),
    rollback: () => connection.rollback(),
    release: () => connection.release(),
  };
}

export function adaptMySql2Pool(pool: Pool): MySqlPoolLike {
  const executable = pool as unknown as Executable;
  return {
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
  const driver = await loadMySql2Driver(options.driverImporter);
  const pool = driver.createPool({
    ...options.poolConfig,
    uri: await uri(options.connectionUri),
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
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
