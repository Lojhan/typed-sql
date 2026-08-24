import type { Pool as PgPool, PoolClient, PoolConfig, QueryConfig } from "pg";
import { type PostgresSchemaSnapshot, type PostgresTypePolicy } from "./index.js";
import { PostgresSchemaProvider, type PostgresQueryable } from "./provider.js";
import {
  createPostgresDatabase,
  type PostgresClientLike,
  type PostgresDatabase,
  type PostgresPoolLike,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from "./runtime.js";

export interface PgOptions {
  readonly connectionString: string | (() => string | Promise<string>);
  readonly poolConfig?: Omit<PoolConfig, "connectionString" | "types">;
  readonly typePolicy?: PostgresTypePolicy;
  readonly decimal?: (value: string) => unknown;
}

export interface PgSchemaProviderOptions {
  readonly connectionString?: string | (() => string | Promise<string>);
  readonly client?: PostgresQueryable;
  readonly schemas?: readonly string[];
  readonly typePolicy?: PostgresTypePolicy;
}

export async function loadPgDriver(
  importer: () => Promise<typeof import("pg")> = () => import("pg"),
): Promise<typeof import("pg")> {
  try {
    return await importer();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error("@typed-sql/postgres/pg requires the application-owned pg driver. Install it with: pnpm add pg", { cause: error });
    }
    throw error;
  }
}

async function connectionString(value: PgOptions["connectionString"]): Promise<string> {
  const resolved = typeof value === "function" ? await value() : value;
  if (resolved.length === 0) throw new TypeError("PostgreSQL connectionString must not be empty");
  return resolved;
}

function queryConfig(config: PostgresQueryConfig): QueryConfig<unknown[]> {
  return {
    text: config.text,
    ...(config.values === undefined ? {} : { values: [...config.values] }),
    ...(config.types === undefined ? {} : { types: config.types }),
  };
}

export function adaptPgPool(pool: PgPool): PostgresPoolLike {
  const wrapClient = (client: PoolClient): PostgresClientLike => ({
    async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
      const result = typeof config === "string"
        ? await client.query<Record<string, unknown>>(config)
        : await client.query<Record<string, unknown>, unknown[]>(queryConfig(config));
      return { rows: result.rows };
    },
    release(): void { client.release(); },
  });
  return {
    async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
      const result = typeof config === "string"
        ? await pool.query<Record<string, unknown>>(config)
        : await pool.query<Record<string, unknown>, unknown[]>(queryConfig(config));
      return { rows: result.rows };
    },
    async connect(): Promise<PostgresClientLike> { return wrapClient(await pool.connect()); },
    async end(): Promise<void> { await pool.end(); },
  };
}

export async function createPgDatabase(options: PgOptions): Promise<PostgresDatabase> {
  const { Pool } = await loadPgDriver();
  const pool = new Pool({ ...options.poolConfig, connectionString: await connectionString(options.connectionString) });
  return createPostgresDatabase({
    pool: adaptPgPool(pool),
    ownsPool: true,
    ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
    ...(options.decimal === undefined ? {} : { decimal: options.decimal }),
  });
}

export function pg(options: PgSchemaProviderOptions): { introspect(): Promise<PostgresSchemaSnapshot> } {
  return {
    async introspect(): Promise<PostgresSchemaSnapshot> {
      if (options.connectionString === undefined && options.client === undefined) {
        throw new TypeError("pg schema provider requires connectionString or client");
      }
      const provider = new PostgresSchemaProvider({
        ...(options.client === undefined ? {} : { client: options.client }),
        ...(options.schemas === undefined ? {} : { includeSchemas: options.schemas }),
        ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
      });
      if (options.client !== undefined) return await provider.introspect({}) as PostgresSchemaSnapshot;
      return await provider.introspect({ url: await connectionString(options.connectionString!) }) as PostgresSchemaSnapshot;
    },
  };
}
