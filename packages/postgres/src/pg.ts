import type { Pool as PgPool, PoolClient, PoolConfig, QueryConfig } from "pg";
import type { PostgresSchemaSnapshot, PostgresTypePolicy } from "./index.js";
import { type PostgresQueryable, PostgresSchemaProvider } from "./provider.js";
import {
  createPostgresDatabase,
  type PostgresClientLike,
  type PostgresCursorLike,
  type PostgresDatabase,
  type PostgresPoolLike,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from "./runtime.js";

export interface PgCursorConstructor {
  new (
    text: string,
    values?: readonly unknown[],
    config?: {
      readonly types?: PostgresQueryConfig["types"];
    },
  ): unknown;
}

export type PgCursorImporter = () => Promise<unknown>;

const pgCursorPackage = "pg-cursor";
const queryTimeoutError =
  "@typed-sql/postgres/pg does not accept pg query_timeout because pg can reject before the connection is ready for reuse; use PostgreSQL statement_timeout instead";

async function defaultPgCursorImporter(): Promise<unknown> {
  return import(pgCursorPackage);
}

function pgCursorConstructor(module: unknown): PgCursorConstructor {
  const candidate =
    typeof module === "object" && module !== null && "default" in module
      ? (module as { readonly default?: unknown }).default
      : module;
  if (typeof candidate !== "function") {
    throw new TypeError("The application-owned pg-cursor package does not export a default Cursor constructor");
  }
  return candidate as PgCursorConstructor;
}

export async function loadPgCursorDriver(
  importer: PgCursorImporter = defaultPgCursorImporter,
): Promise<PgCursorConstructor> {
  try {
    return pgCursorConstructor(await importer());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "@typed-sql/postgres/pg streaming requires the application-owned pg-cursor package. Install it with: pnpm add pg-cursor",
        { cause: error },
      );
    }
    throw error;
  }
}

export interface PgOptions {
  readonly connectionString: string | (() => string | Promise<string>);
  readonly poolConfig?: Omit<PoolConfig, "connectionString" | "query_timeout" | "types">;
  readonly typePolicy?: PostgresTypePolicy;
  readonly decimal?: (value: string) => unknown;
  /** Host-injected loader for workspaces or runtimes with nonstandard package resolution. */
  readonly cursorImporter?: PgCursorImporter;
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
      throw new Error("@typed-sql/postgres/pg requires the application-owned pg driver. Install it with: pnpm add pg", {
        cause: error,
      });
    }
    throw error;
  }
}

async function connectionString(value: PgOptions["connectionString"]): Promise<string> {
  const resolved = typeof value === "function" ? await value() : value;
  if (resolved.length === 0) throw new TypeError("PostgreSQL connectionString must not be empty");
  return resolved;
}

function validatePoolConfig(poolConfig: PgOptions["poolConfig"]): void {
  if (poolConfig !== undefined && "query_timeout" in poolConfig) throw new TypeError(queryTimeoutError);
  if (poolConfig !== undefined && "types" in poolConfig) {
    throw new TypeError(
      "@typed-sql/postgres/pg owns poolConfig.types so decoded values match typePolicy; remove that option",
    );
  }
}

function validateConnectionStringQueryTimeout(value: string): void {
  try {
    const url = new URL(value);
    for (const name of url.searchParams.keys()) {
      if (name === "query_timeout") throw new TypeError(queryTimeoutError);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === queryTimeoutError) throw error;
    // Let pg report malformed or non-URL connection strings through its normal validation path.
  }
}

function queryConfig(config: PostgresQueryConfig): QueryConfig<unknown[]> {
  return {
    ...(config.name === undefined ? {} : { name: config.name }),
    text: config.text,
    ...(config.values === undefined ? {} : { values: [...config.values] }),
    ...(config.types === undefined ? {} : { types: config.types }),
  };
}

export function adaptPgPool(
  pool: PgPool,
  cursorImporter: PgCursorImporter = defaultPgCursorImporter,
): PostgresPoolLike {
  const options = (
    pool as PgPool & {
      readonly options?: { readonly connectionString?: unknown; readonly query_timeout?: unknown };
    }
  ).options;
  if (options !== undefined && "query_timeout" in options) throw new TypeError(queryTimeoutError);
  if (typeof options?.connectionString === "string") validateConnectionStringQueryTimeout(options.connectionString);
  let cursorConstructorPromise: Promise<PgCursorConstructor> | undefined;
  const loadCursor = (): Promise<PgCursorConstructor> => {
    cursorConstructorPromise ??= loadPgCursorDriver(cursorImporter);
    return cursorConstructorPromise;
  };
  const wrapClient = (client: PoolClient): PostgresClientLike => {
    let fatalError: Error | undefined;
    let rejectFatal!: (error: Error) => void;
    const fatalSettlement = new Promise<never>((_resolve, reject) => {
      rejectFatal = reject;
    });
    // The promise intentionally remains pending for a healthy lease and must never be unhandled.
    void fatalSettlement.catch(() => undefined);
    const recordFatal = (error: Error): void => {
      if (fatalError !== undefined) return;
      fatalError = error;
      rejectFatal(error);
    };
    const onError = (error: Error): void => recordFatal(error);
    const onEnd = (): void => recordFatal(new Error("The PostgreSQL connection ended while it was leased"));
    client.on("error", onError);
    client.on("end", onEnd);

    return {
      async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
        const result =
          typeof config === "string"
            ? await client.query<Record<string, unknown>>(config)
            : await client.query<Record<string, unknown>, unknown[]>(queryConfig(config));
        return { rows: result.rows };
      },
      async openCursor(config: PostgresQueryConfig): Promise<PostgresCursorLike> {
        const Cursor = await loadCursor();
        // pg-cursor always parses an unnamed statement. Keep the prepared name in typed-sql's
        // driver-neutral config, but do not pretend the native cursor can honor it.
        const cursor = new Cursor(config.text, config.values, {
          ...(config.types === undefined ? {} : { types: config.types }),
        });
        const queryCursor = client.query.bind(client) as unknown as (value: unknown) => PostgresCursorLike;
        const nativeCursor = queryCursor(cursor);
        return {
          read: (rowCount) => nativeCursor.read(rowCount),
          async close(): Promise<void> {
            if (fatalError !== undefined) throw fatalError;
            const nativeClose = nativeCursor.close();
            // Keep observing the native promise even when fatal settlement wins the race.
            void nativeClose.catch(() => undefined);
            await Promise.race([nativeClose, fatalSettlement]);
          },
        };
      },
      release(error?: Error | boolean): void {
        client.removeListener("error", onError);
        client.removeListener("end", onEnd);
        client.release(error === undefined ? fatalError : error);
      },
    };
  };
  return {
    async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
      const result =
        typeof config === "string"
          ? await pool.query<Record<string, unknown>>(config)
          : await pool.query<Record<string, unknown>, unknown[]>(queryConfig(config));
      return { rows: result.rows };
    },
    async ensureCursor(): Promise<void> {
      await loadCursor();
    },
    async connect(): Promise<PostgresClientLike> {
      return wrapClient(await pool.connect());
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}

export async function createPgDatabase(options: PgOptions): Promise<PostgresDatabase> {
  validatePoolConfig(options.poolConfig);
  const resolvedConnectionString = await connectionString(options.connectionString);
  validateConnectionStringQueryTimeout(resolvedConnectionString);
  const driver = await loadPgDriver();
  const { Pool } = driver;
  const pool = new Pool({ ...options.poolConfig, connectionString: resolvedConnectionString });
  return createPostgresDatabase({
    pool: adaptPgPool(pool, options.cursorImporter),
    ownsPool: true,
    fallbackTypeParsers: driver.types,
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
      if (options.client !== undefined) return (await provider.introspect({})) as PostgresSchemaSnapshot;
      return (await provider.introspect({
        url: await connectionString(options.connectionString!),
      })) as PostgresSchemaSnapshot;
    },
  };
}
