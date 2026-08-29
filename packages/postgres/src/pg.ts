import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { DatabaseObserver, LiveQueryVerifier, QueryPlanEvidence, QueryPlanInspector } from "@typed-sql/core";
import type { Pool as PgPool, PoolClient, PoolConfig, QueryConfig } from "pg";
import type { PostgresSchemaSnapshot } from "./index.js";
import { type PostgresQueryable, PostgresSchemaProvider } from "./provider.js";
import {
  createPostgresDatabase,
  type PostgresClientLike,
  type PostgresCopyFromSink,
  type PostgresCopyToSource,
  type PostgresCursorLike,
  type PostgresDatabase,
  type PostgresPoolLike,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from "./runtime.js";
import {
  defaultPostgresTypePolicy,
  isKnownPostgresType,
  mapPostgresType,
  type PostgresTypePolicy,
} from "./type-policy.js";

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

export interface PgCopyStreamsModule {
  readonly from: (statement: string) => unknown;
  readonly to: (statement: string) => unknown;
}

export type PgCopyStreamsImporter = () => Promise<unknown>;

const pgCursorPackage = "pg-cursor";
const pgCopyStreamsPackage = "pg-copy-streams";
const queryTimeoutError =
  "@typed-sql/postgres/pg does not accept pg query_timeout because pg can reject before the connection is ready for reuse; use PostgreSQL statement_timeout instead";

async function defaultPgCursorImporter(): Promise<unknown> {
  return import(pgCursorPackage);
}

async function defaultPgCopyStreamsImporter(): Promise<unknown> {
  return import(pgCopyStreamsPackage);
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

export async function loadPgCopyStreams(
  importer: PgCopyStreamsImporter = defaultPgCopyStreamsImporter,
): Promise<PgCopyStreamsModule> {
  try {
    const module = await importer();
    if (
      typeof module !== "object" ||
      module === null ||
      typeof (module as Partial<PgCopyStreamsModule>).from !== "function" ||
      typeof (module as Partial<PgCopyStreamsModule>).to !== "function"
    ) {
      throw new TypeError("The application-owned pg-copy-streams package must export from() and to() factories");
    }
    return module as PgCopyStreamsModule;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "@typed-sql/postgres/pg COPY requires the application-owned pg-copy-streams package. Install it with: pnpm add pg-copy-streams",
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
  /** Host-injected loader for the optional pg-copy-streams bulk protocol package. */
  readonly copyStreamsImporter?: PgCopyStreamsImporter;
  readonly observer?: DatabaseObserver;
}

export interface PgSchemaProviderOptions {
  readonly connectionString?: string | (() => string | Promise<string>);
  readonly client?: PostgresQueryable;
  readonly schemas?: readonly string[];
  readonly typePolicy?: PostgresTypePolicy;
}

export interface PgLiveVerifierClient {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
  release(error?: Error | boolean): void;
}

export interface PgLiveVerifierPool {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
  connect(): Promise<PgLiveVerifierClient>;
  end(): Promise<void>;
}

export interface PgLiveVerifierOptions {
  readonly connectionString?: string | (() => string | Promise<string>);
  readonly pool?: PgLiveVerifierPool;
  readonly poolConfig?: Omit<PoolConfig, "connectionString">;
  readonly typePolicy?: PostgresTypePolicy;
  readonly schema?: PostgresSchemaSnapshot;
  readonly driverImporter?: () => Promise<typeof import("pg")>;
}

export interface PgPlanInspectorOptions {
  readonly connectionString?: string | (() => string | Promise<string>);
  readonly pool?: PgPlanInspectorPool;
  readonly poolConfig?: Omit<PoolConfig, "connectionString">;
  readonly driverImporter?: () => Promise<typeof import("pg")>;
}

export interface PgPlanInspectorClient {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
  release(error?: Error | boolean): void;
}

export interface PgPlanInspectorPool {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
  connect(): Promise<PgPlanInspectorClient>;
  end(): Promise<void>;
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

const POSTGRES_LIVE_VERIFIER_VERSION = "postgres-prepare-v1";

/** Creates a lazy adapter over PostgreSQL PREPARE and pg_prepared_statements. */
export function createPgLiveVerifier(options: PgLiveVerifierOptions): LiveQueryVerifier {
  const ownsPool = options.pool === undefined;
  let poolPromise: Promise<PgLiveVerifierPool> | undefined;
  let serverPromise: ReturnType<LiveQueryVerifier["server"]> | undefined;
  const acquirePool = (): Promise<PgLiveVerifierPool> => {
    poolPromise ??= (async () => {
      if (options.pool !== undefined) return options.pool;
      if (options.connectionString === undefined)
        throw new TypeError("PostgreSQL live verification requires connectionString or pool");
      const value = await connectionString(options.connectionString);
      const { Pool } = await loadPgDriver(options.driverImporter);
      return new Pool({ ...options.poolConfig, connectionString: value }) as unknown as PgLiveVerifierPool;
    })();
    return poolPromise;
  };
  const server = async () => {
    serverPromise ??= (async () => {
      const pool = await acquirePool();
      const version = await pool.query<{ readonly version: string }>(
        "SELECT current_setting('server_version') AS version",
      );
      const extensions = await pool.query<{ readonly extension: string }>(
        "SELECT extname || ':' || extversion AS extension FROM pg_extension ORDER BY extname",
      );
      return { version: version.rows[0]?.version ?? "unknown", features: extensions.rows.map((row) => row.extension) };
    })();
    return serverPromise;
  };
  return {
    dialect: "postgres",
    adapterVersion: POSTGRES_LIVE_VERIFIER_VERSION,
    server,
    async verify(request) {
      if (!/^sha256:[a-f\d]{64}$/u.test(request.fingerprint)) {
        throw new TypeError("PostgreSQL live verification requires a SHA-256 query fingerprint");
      }
      const pool = await acquirePool();
      const client = await pool.connect();
      const name = `typed_sql_${request.fingerprint.replace(/^sha256:/u, "").slice(0, 32)}`;
      let prepared = false;
      let evidence: Awaited<ReturnType<LiveQueryVerifier["verify"]>> | undefined;
      let failure: unknown;
      try {
        await client.query(`PREPARE ${name} AS ${request.sql}`);
        prepared = true;
        const major = Number.parseInt((await server()).version.split(".")[0] ?? "0", 10);
        const metadata = await client.query<{
          readonly parameterTypes: readonly string[];
          readonly resultTypes?: readonly string[] | null;
        }>(
          major >= 18
            ? `SELECT parameter_types::text[] AS "parameterTypes", result_types::text[] AS "resultTypes" FROM pg_prepared_statements WHERE name = '${name}'`
            : `SELECT parameter_types::text[] AS "parameterTypes" FROM pg_prepared_statements WHERE name = '${name}'`,
        );
        const row = metadata.rows[0];
        if (row === undefined) throw new Error("Prepared statement metadata was not returned");
        const policy = options.typePolicy ?? defaultPostgresTypePolicy;
        const fields = (types: readonly string[] | null | undefined) =>
          (types ?? []).map((databaseType, offset) => ({
            index: offset + 1,
            databaseType,
            ...(isKnownPostgresType(databaseType, options.schema)
              ? { tsType: mapPostgresType(databaseType, policy, options.schema) }
              : {}),
          }));
        evidence = {
          parameters: fields(row.parameterTypes),
          columns: fields(row.resultTypes),
          ...(major >= 18 ? {} : { unavailable: ["columns"] as const }),
        };
      } catch (error) {
        failure = error;
      }
      let cleanupFailure: unknown;
      if (prepared) {
        try {
          await client.query(`DEALLOCATE ${name}`);
        } catch (error) {
          cleanupFailure = error;
        }
      }
      client.release(
        cleanupFailure instanceof Error ? cleanupFailure : cleanupFailure === undefined ? undefined : true,
      );
      if (failure !== undefined) throw failure;
      if (cleanupFailure !== undefined) throw cleanupFailure;
      if (evidence === undefined) throw new Error("PostgreSQL verification produced no evidence");
      return evidence;
    },
    async close() {
      if (ownsPool && poolPromise !== undefined) await (await poolPromise).end();
    },
  };
}

const POSTGRES_PLAN_INSPECTOR_VERSION = "postgres-explain-json-v1";
const postgresPlanSettings = [
  "cpu_index_tuple_cost",
  "cpu_operator_cost",
  "cpu_tuple_cost",
  "cursor_tuple_fraction",
  "default_statistics_target",
  "effective_cache_size",
  "effective_io_concurrency",
  "enable_bitmapscan",
  "enable_gathermerge",
  "enable_hashagg",
  "enable_hashjoin",
  "enable_incremental_sort",
  "enable_indexonlyscan",
  "enable_indexscan",
  "enable_material",
  "enable_memoize",
  "enable_mergejoin",
  "enable_nestloop",
  "enable_parallel_append",
  "enable_parallel_hash",
  "enable_partition_pruning",
  "enable_partitionwise_aggregate",
  "enable_partitionwise_join",
  "enable_seqscan",
  "enable_sort",
  "enable_tidscan",
  "jit",
  "max_parallel_workers_per_gather",
  "min_parallel_index_scan_size",
  "min_parallel_table_scan_size",
  "parallel_setup_cost",
  "parallel_tuple_cost",
  "plan_cache_mode",
  "random_page_cost",
  "work_mem",
] as const;

function postgresPlan(value: unknown): QueryPlanEvidence {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const document = Array.isArray(parsed) ? parsed[0] : undefined;
  const root =
    typeof document === "object" && document !== null && "Plan" in document
      ? (document as { readonly Plan?: unknown }).Plan
      : undefined;
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new TypeError("PostgreSQL returned an unsupported JSON plan");
  }
  const rootRecord = root as Readonly<Record<string, unknown>>;
  const nodes: QueryPlanEvidence["nodes"][number][] = [];
  const visit = (value: Readonly<Record<string, unknown>>) => {
    const kind = value["Node Type"];
    if (typeof kind !== "string" || kind.length === 0) throw new TypeError("PostgreSQL plan node has no type");
    const relation = value["Relation Name"];
    const index = value["Index Name"];
    const estimatedRows = value["Plan Rows"];
    const estimatedCost = value["Total Cost"];
    nodes.push({
      kind,
      ...(typeof relation === "string" ? { relation } : {}),
      ...(typeof index === "string" ? { index } : {}),
      ...(typeof estimatedRows === "number" ? { estimatedRows } : {}),
      ...(typeof estimatedCost === "number" ? { estimatedCost } : {}),
    });
    const children = value.Plans;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child !== "object" || child === null || Array.isArray(child)) {
          throw new TypeError("PostgreSQL plan child is invalid");
        }
        visit(child as Readonly<Record<string, unknown>>);
      }
    }
  };
  visit(rootRecord);
  return {
    ...(typeof rootRecord["Total Cost"] === "number" ? { totalCost: rootRecord["Total Cost"] } : {}),
    ...(typeof rootRecord["Plan Rows"] === "number" ? { estimatedRows: rootRecord["Plan Rows"] } : {}),
    nodes,
  };
}

/** Creates a lazy, non-executing adapter over PostgreSQL structured EXPLAIN. */
export function createPgPlanInspector(options: PgPlanInspectorOptions): QueryPlanInspector {
  const ownsPool = options.pool === undefined;
  let poolPromise: Promise<PgPlanInspectorPool> | undefined;
  let environmentPromise: ReturnType<QueryPlanInspector["environment"]> | undefined;
  const acquirePool = (): Promise<PgPlanInspectorPool> => {
    poolPromise ??= (async () => {
      if (options.pool !== undefined) return options.pool;
      if (options.connectionString === undefined) {
        throw new TypeError("PostgreSQL plan capture requires connectionString or pool");
      }
      const value = await connectionString(options.connectionString);
      const { Pool } = await loadPgDriver(options.driverImporter);
      return new Pool({ ...options.poolConfig, connectionString: value }) as unknown as PgPlanInspectorPool;
    })();
    return poolPromise;
  };
  return {
    dialect: "postgres",
    adapterVersion: POSTGRES_PLAN_INSPECTOR_VERSION,
    parameterMode: "value-free",
    async environment() {
      environmentPromise ??= (async () => {
        const pool = await acquirePool();
        const versionResult = await pool.query<{ readonly version: string }>(
          "SELECT current_setting('server_version') AS version",
        );
        const settingResult = await pool.query<{ readonly name: string; readonly setting: string }>(
          "SELECT name, setting FROM pg_settings WHERE name = ANY($1::text[]) ORDER BY name",
          [postgresPlanSettings],
        );
        const statistics = await pool.query<Record<string, string>>(
          "SELECT schemaname, relname, n_live_tup::text, n_dead_tup::text, COALESCE(last_analyze::text, '') AS last_analyze, COALESCE(last_autoanalyze::text, '') AS last_autoanalyze FROM pg_stat_all_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, relname",
        );
        return {
          version: versionResult.rows[0]?.version ?? "unknown",
          settings: Object.fromEntries(settingResult.rows.map((row) => [row.name, row.setting])),
          statisticsFingerprint: `sha256:${createHash("sha256").update(JSON.stringify(statistics.rows)).digest("hex")}`,
        };
      })();
      return environmentPromise;
    },
    async capture(request) {
      if (!/^sha256:[a-f\d]{64}$/u.test(request.fingerprint)) {
        throw new TypeError("PostgreSQL plan capture requires a SHA-256 query fingerprint");
      }
      if (request.values !== undefined && request.values.length !== request.parameterCount) {
        throw new TypeError("PostgreSQL plan samples do not match the parameter count");
      }
      const client = await (await acquirePool()).connect();
      let failure: unknown;
      try {
        const prefix =
          request.values === undefined ? "EXPLAIN (GENERIC_PLAN TRUE, FORMAT JSON) " : "EXPLAIN (FORMAT JSON) ";
        const result = await client.query<Record<string, unknown>>(`${prefix}${request.sql}`, request.values);
        return postgresPlan(result.rows[0]?.["QUERY PLAN"]);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        client.release(failure instanceof Error ? failure : failure === undefined ? undefined : true);
      }
    },
    async close() {
      if (ownsPool && poolPromise !== undefined) await (await poolPromise).end();
    },
  };
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
  copyStreamsImporter: PgCopyStreamsImporter = defaultPgCopyStreamsImporter,
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
  let copyStreamsPromise: Promise<PgCopyStreamsModule> | undefined;
  const loadCopyStreams = (): Promise<PgCopyStreamsModule> => {
    copyStreamsPromise ??= loadPgCopyStreams(copyStreamsImporter);
    return copyStreamsPromise;
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
      pipeline: client.pipeline,
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
      async openCopyFrom(statement: string): Promise<PostgresCopyFromSink> {
        const copy = await loadCopyStreams();
        const nativeQuery = client.query.bind(client) as unknown as (query: unknown) => Writable;
        const writable = nativeQuery(copy.from(statement));
        const terminal = finished(writable);
        void terminal.catch(() => undefined);
        return {
          async write(chunk): Promise<void> {
            if (!writable.write(chunk)) await once(writable, "drain");
          },
          async finish(): Promise<void> {
            writable.end();
            await terminal;
          },
          async abort(error): Promise<void> {
            writable.destroy(error instanceof Error ? error : new Error("PostgreSQL COPY FROM aborted"));
            await terminal.catch(() => undefined);
          },
        };
      },
      async openCopyTo(statement: string): Promise<PostgresCopyToSource> {
        const copy = await loadCopyStreams();
        const nativeQuery = client.query.bind(client) as unknown as (query: unknown) => Readable;
        const readable = nativeQuery(copy.to(statement));
        const terminal = finished(readable);
        void terminal.catch(() => undefined);
        const iterator = readable[Symbol.asyncIterator]();
        let complete = false;
        const close = async (): Promise<void> => {
          const early = !complete;
          complete = true;
          if (early) readable.destroy();
          if (early) await terminal.catch(() => undefined);
          else await terminal;
        };
        const source: PostgresCopyToSource = {
          [Symbol.asyncIterator](): PostgresCopyToSource {
            return source;
          },
          async next(): Promise<IteratorResult<Uint8Array, undefined>> {
            const result = await iterator.next();
            if (result.done === true) {
              complete = true;
              return { done: true, value: undefined };
            }
            const value = result.value;
            return {
              done: false,
              value: value instanceof Uint8Array ? value : Buffer.from(value as string),
            };
          },
          async return(): Promise<IteratorResult<Uint8Array, undefined>> {
            await close();
            return { done: true, value: undefined };
          },
          close,
          async abort(error): Promise<void> {
            readable.destroy(error instanceof Error ? error : new Error("PostgreSQL COPY TO aborted"));
            await terminal.catch(() => undefined);
            complete = true;
          },
          async [Symbol.asyncDispose](): Promise<void> {
            await close();
          },
        };
        return source;
      },
      release(error?: Error | boolean): void {
        client.removeListener("error", onError);
        client.removeListener("end", onEnd);
        client.release(error === undefined ? fatalError : error);
      },
    };
  };
  return {
    executionCapabilities: Object.freeze({ cancellation: true, deadlines: true }),
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
    async ensureCopy(): Promise<void> {
      await loadCopyStreams();
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
    pool: adaptPgPool(pool, options.cursorImporter, options.copyStreamsImporter),
    ownsPool: true,
    fallbackTypeParsers: driver.types,
    ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
    ...(options.decimal === undefined ? {} : { decimal: options.decimal }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
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
