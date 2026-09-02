import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type {
  DatabaseObserver,
  DialectServerEvidence,
  LiveQueryVerifier,
  QueryPlanEvidence,
  QueryPlanInspector,
} from "@typed-sql/core";
import type { Pool as PgPool, PoolClient, PoolConfig, QueryConfig } from "pg";
import { postgresServerEvidence } from "./capabilities.js";
import {
  type PostgresExtensionCodec,
  type PostgresExtensionManifest,
  PostgresExtensionResolutionError,
  resolvePostgresExtensionManifests,
} from "./extensions.js";
import type { PostgresSchemaSnapshot } from "./index.js";
import { type PostgresQueryable, PostgresSchemaProvider, postgresCatalogQueries } from "./provider.js";
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
  type PostgresRuntimeCodec,
} from "./runtime.js";
import { parsePostgresRuntimeSnapshot, validatePostgresRuntimeCompatibility } from "./runtime-compatibility.js";
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

export type PostgresAdapterErrorKind = "connection-loss" | "driver" | "server" | "timeout" | "transaction-abort";

/** Stable adapter classification that retains the original driver failure as `cause`. */
export class PostgresAdapterError extends Error {
  readonly code = "POSTGRES_ADAPTER_ERROR";
  readonly kind: PostgresAdapterErrorKind;
  readonly sqlState: string | undefined;

  constructor(kind: PostgresAdapterErrorKind, message: string, sqlState: string | undefined, cause: unknown) {
    super(message, { cause });
    this.name = "PostgresAdapterError";
    this.kind = kind;
    this.sqlState = sqlState;
  }
}

function errorRecord(error: unknown): { readonly code?: unknown; readonly message?: unknown } {
  return typeof error === "object" && error !== null ? error : {};
}

/** Converts driver-specific failures into a value-safe, SQL-free adapter outcome. */
export function normalizePostgresAdapterError(error: unknown): PostgresAdapterError {
  if (error instanceof PostgresAdapterError) return error;
  const record = errorRecord(error);
  const sqlState = typeof record.code === "string" && /^[A-Z\d]{5}$/u.test(record.code) ? record.code : undefined;
  const message = typeof record.message === "string" ? record.message : "PostgreSQL driver operation failed";
  const kind: PostgresAdapterErrorKind =
    sqlState === "25P02"
      ? "transaction-abort"
      : sqlState === "57014" && /statement timeout/iu.test(message)
        ? "timeout"
        : sqlState?.startsWith("08") === true ||
            sqlState === "57P01" ||
            ["ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(String(record.code)) ||
            /connection (?:ended|terminated|lost)/iu.test(message)
          ? "connection-loss"
          : sqlState === undefined
            ? "driver"
            : "server";
  return new PostgresAdapterError(kind, message, sqlState, error);
}

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
  /** Generated snapshot file whose evidence must match before this adapter can execute. */
  readonly compatibilitySnapshot?: string | URL;
  readonly extensionManifests?: readonly PostgresExtensionManifest[];
  /** Maximum named statements retained by each pooled connection. Defaults to 256. */
  readonly statementCacheSize?: number;
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
  readonly extensionManifests?: readonly PostgresExtensionManifest[];
}

export interface PgLiveVerifierClient {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
  release(error?: Error | boolean): void;
}

interface PgProtocolField {
  readonly name: string;
  readonly dataTypeID: number;
}

interface PgProtocolDescription {
  readonly parameters: readonly number[];
  readonly columns: readonly PgProtocolField[];
}

interface PgProtocolConnection {
  parse(request: { readonly text: string; readonly name: string; readonly types: readonly number[] }): void;
  describe(request: { readonly type: "S"; readonly name: string }): void;
  sync(): void;
  on(event: "parameterDescription", listener: (message: { readonly dataTypeIDs: readonly number[] }) => void): void;
  off(event: "parameterDescription", listener: (message: { readonly dataTypeIDs: readonly number[] }) => void): void;
}

interface PgProtocolClient extends PgLiveVerifierClient {
  readonly connection?: PgProtocolConnection;
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

export interface PgRuntimeEvidenceQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
}

interface PgRuntimeVersionRow extends Record<string, unknown> {
  readonly server_version: string;
  readonly standard_conforming_strings?: string;
  readonly search_path?: string;
  readonly extensions?: readonly string[];
}

/** Reads canonical, non-secret compatibility evidence from a PostgreSQL connection or pool. */
export async function readPgRuntimeServerEvidence(
  queryable: PgRuntimeEvidenceQueryable,
): Promise<DialectServerEvidence> {
  const result = await queryable.query<PgRuntimeVersionRow>(postgresCatalogQueries.version);
  const row = result.rows[0];
  if (row === undefined || typeof row.server_version !== "string") {
    throw new TypeError("PostgreSQL runtime compatibility did not return server-version evidence");
  }
  return postgresServerEvidence(row.server_version, row.extensions ?? [], {
    ...(row.standard_conforming_strings === undefined
      ? {}
      : { standardConformingStrings: row.standard_conforming_strings }),
    ...(row.search_path === undefined ? {} : { searchPath: row.search_path }),
    visibilityScope: "current-role",
  });
}

interface PgRuntimeCodecRow extends Record<string, unknown> {
  readonly database_type: string;
  readonly oid: number | null;
  readonly array_oid: number | null;
}

const runtimeCodecOidQuery = `
  SELECT requested.database_type,
         t.oid::int AS oid,
         NULLIF(t.typarray, 0)::int AS array_oid
  FROM unnest($1::text[]) AS requested(database_type)
  LEFT JOIN pg_catalog.pg_type AS t ON t.oid = pg_catalog.to_regtype(requested.database_type)
  ORDER BY requested.database_type
`;

/** Resolves manifest type names to connection-local OIDs for per-query parser installation. */
export async function resolvePgRuntimeCodecs(
  queryable: PgRuntimeEvidenceQueryable,
  codecs: ReadonlyMap<string, PostgresExtensionCodec>,
): Promise<readonly PostgresRuntimeCodec[]> {
  const names = [...codecs.keys()].sort();
  if (names.length === 0) return [];
  const result = await queryable.query<PgRuntimeCodecRow>(runtimeCodecOidQuery, [names]);
  const rows = new Map(result.rows.map((row) => [row.database_type.toLowerCase(), row]));
  return names.map((databaseType) => {
    const row = rows.get(databaseType);
    const codec = codecs.get(databaseType)!;
    if (row?.oid === null || row === undefined || !Number.isSafeInteger(row.oid) || row.oid < 1) {
      throw new PostgresExtensionResolutionError([
        { code: "TSQ407", message: `PostgreSQL extension codec type ${databaseType} is not visible at runtime` },
      ]);
    }
    if (row.array_oid !== null && (!Number.isSafeInteger(row.array_oid) || row.array_oid < 1)) {
      throw new PostgresExtensionResolutionError([
        { code: "TSQ407", message: `PostgreSQL extension codec array type ${databaseType}[] has an invalid OID` },
      ]);
    }
    return {
      oid: row.oid,
      ...(row.array_oid === null ? {} : { arrayOid: row.array_oid }),
      decode: codec.decode,
    };
  });
}

const POSTGRES_LIVE_VERIFIER_VERSION = "postgres-describe-v2";

function describePgStatement(
  client: PgLiveVerifierClient,
  name: string,
  sql: string,
): Promise<PgProtocolDescription> | undefined {
  const protocolClient = client as PgProtocolClient;
  if (protocolClient.connection === undefined) return undefined;
  return new Promise((resolve, reject) => {
    let parameters: readonly number[] = [];
    let columns: readonly PgProtocolField[] = [];
    let connection: PgProtocolConnection | undefined;
    let settled = false;
    const parameterDescription = (message: { readonly dataTypeIDs: readonly number[] }): void => {
      parameters = [...message.dataTypeIDs];
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      connection?.off("parameterDescription", parameterDescription);
      if (error === undefined) resolve({ parameters, columns });
      else reject(error);
    };
    const query = {
      name,
      text: sql,
      callback: undefined as ((error?: unknown) => void) | undefined,
      submit(value: PgProtocolConnection) {
        connection = value;
        value.on("parameterDescription", parameterDescription);
        value.parse({ text: sql, name, types: [] });
        value.describe({ type: "S", name });
        value.sync();
      },
      handleRowDescription(message: { readonly fields: readonly PgProtocolField[] }) {
        columns = message.fields.map(({ name: fieldName, dataTypeID }) => ({ name: fieldName, dataTypeID }));
      },
      handleError(error: unknown) {
        finish(error);
      },
      handleReadyForQuery() {
        finish();
      },
    };
    type CustomQueryClient = {
      query(value: typeof query, callback: (error?: unknown) => void): void;
    };
    (client as unknown as CustomQueryClient).query(query, (error) => {
      if (error !== undefined) finish(error);
    });
  });
}

/** Creates a lazy, non-executing adapter over PostgreSQL Parse and Describe metadata. */
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
        const protocol = describePgStatement(client, name, request.sql);
        let parameterTypes: readonly string[];
        let resultTypes: readonly { readonly name?: string; readonly databaseType: string }[];
        let unavailable: readonly "columns"[] | undefined;
        if (protocol === undefined) {
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
          parameterTypes = row.parameterTypes;
          resultTypes = (row.resultTypes ?? []).map((databaseType) => ({ databaseType }));
          if (major < 18) unavailable = ["columns"];
        } else {
          const description = await protocol;
          prepared = true;
          const oids = [
            ...new Set([...description.parameters, ...description.columns.map(({ dataTypeID }) => dataTypeID)]),
          ];
          const types = await client.query<{ readonly oid: number; readonly databaseType: string }>(
            `SELECT oid, format_type(oid, NULL) AS "databaseType" FROM pg_type WHERE oid = ANY($1::oid[])`,
            [oids],
          );
          const names = new Map(types.rows.map(({ oid, databaseType }) => [oid, databaseType]));
          parameterTypes = description.parameters.map((oid) => names.get(oid) ?? `oid:${oid}`);
          resultTypes = description.columns.map(({ name: fieldName, dataTypeID }) => ({
            name: fieldName,
            databaseType: names.get(dataTypeID) ?? `oid:${dataTypeID}`,
          }));
        }
        const policy = options.typePolicy ?? defaultPostgresTypePolicy;
        const fields = (types: readonly { readonly name?: string; readonly databaseType: string }[]) =>
          types.map(({ name: fieldName, databaseType }, offset) => ({
            index: offset + 1,
            databaseType,
            ...(fieldName === undefined ? {} : { name: fieldName }),
            ...(isKnownPostgresType(databaseType, options.schema)
              ? { tsType: mapPostgresType(databaseType, policy, options.schema) }
              : {}),
          }));
        evidence = {
          parameters: fields(parameterTypes.map((databaseType) => ({ databaseType }))),
          columns: fields(resultTypes),
          ...(unavailable === undefined ? {} : { unavailable }),
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

const POSTGRES_PLAN_INSPECTOR_VERSION = "postgres-explain-json-v2";
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
        if (request.values !== undefined) {
          const result = await client.query<Record<string, unknown>>(
            `EXPLAIN (FORMAT JSON) ${request.sql}`,
            request.values,
          );
          return postgresPlan(result.rows[0]?.["QUERY PLAN"]);
        }
        const major = Number.parseInt((await this.environment()).version.split(".")[0] ?? "0", 10);
        if (major >= 16) {
          const result = await client.query<Record<string, unknown>>(
            `EXPLAIN (GENERIC_PLAN TRUE, FORMAT JSON) ${request.sql}`,
          );
          return postgresPlan(result.rows[0]?.["QUERY PLAN"]);
        }
        const name = `typed_sql_plan_${request.fingerprint.replace(/^sha256:/u, "").slice(0, 32)}`;
        const quotedName = quotePreparedStatementName(name);
        let transaction = false;
        let prepared = false;
        try {
          await client.query("BEGIN");
          transaction = true;
          await client.query("SET LOCAL plan_cache_mode = force_generic_plan");
          await client.query(`PREPARE ${quotedName} AS ${request.sql}`);
          prepared = true;
          const parameters =
            request.parameterCount === 0
              ? ""
              : `(${Array.from({ length: request.parameterCount }, () => "NULL").join(", ")})`;
          const result = await client.query<Record<string, unknown>>(
            `EXPLAIN (FORMAT JSON) EXECUTE ${quotedName}${parameters}`,
          );
          await client.query(`DEALLOCATE ${quotedName}`);
          prepared = false;
          await client.query("ROLLBACK");
          transaction = false;
          return postgresPlan(result.rows[0]?.["QUERY PLAN"]);
        } catch (error) {
          if (transaction) await client.query("ROLLBACK").catch(() => undefined);
          if (prepared) await client.query(`DEALLOCATE ${quotedName}`).catch(() => undefined);
          throw error;
        }
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

function statementCacheSize(value: number | undefined): number {
  const size = value ?? 256;
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new TypeError("PostgreSQL statementCacheSize must be a positive safe integer");
  }
  return size;
}

function changesPreparedStatementIdentity(source: string): boolean {
  const sql = source.replace(/^\s*(?:(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/))*/u, "").trimStart();
  return (
    /^(?:ALTER|COMMENT|CREATE|DISCARD|DROP|GRANT|REINDEX|REVOKE|TRUNCATE)\b/iu.test(sql) ||
    /^(?:RESET\s+search_path|SET(?:\s+(?:LOCAL|SESSION))?\s+search_path\b)/iu.test(sql)
  );
}

function quotePreparedStatementName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export interface AdaptPgPoolOptions {
  readonly statementCacheSize?: number;
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
  adapterOptions: AdaptPgPoolOptions = {},
): PostgresPoolLike {
  const options = (
    pool as PgPool & {
      readonly options?: { readonly connectionString?: unknown; readonly query_timeout?: unknown };
    }
  ).options;
  if (options !== undefined && "query_timeout" in options) throw new TypeError(queryTimeoutError);
  if (typeof options?.connectionString === "string") validateConnectionStringQueryTimeout(options.connectionString);
  const maximumPreparedStatements = statementCacheSize(adapterOptions.statementCacheSize);
  let preparedGeneration = 0;
  interface PreparedConnectionState {
    generation: number;
    readonly statements: Map<string, string>;
  }
  const preparedConnections = new WeakMap<PoolClient, PreparedConnectionState>();
  const preparedState = (client: PoolClient): PreparedConnectionState => {
    const existing = preparedConnections.get(client);
    if (existing !== undefined) return existing;
    const created = { generation: preparedGeneration, statements: new Map<string, string>() };
    preparedConnections.set(client, created);
    return created;
  };
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
    const statementState = preparedState(client);
    let fatalError: Error | undefined;
    let rejectFatal!: (error: Error) => void;
    const fatalSettlement = new Promise<never>((_resolve, reject) => {
      rejectFatal = reject;
    });
    // The promise intentionally remains pending for a healthy lease and must never be unhandled.
    void fatalSettlement.catch(() => undefined);
    const recordFatal = (error: Error): void => {
      if (fatalError !== undefined) return;
      fatalError = normalizePostgresAdapterError(error);
      rejectFatal(fatalError);
    };
    const onError = (error: Error): void => recordFatal(error);
    const onEnd = (): void => recordFatal(new Error("The PostgreSQL connection ended while it was leased"));
    client.on("error", onError);
    client.on("end", onEnd);

    return {
      pipeline: client.pipeline,
      async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
        try {
          if (statementState.generation !== preparedGeneration) {
            await client.query("DEALLOCATE ALL");
            statementState.statements.clear();
            statementState.generation = preparedGeneration;
          }
          if (typeof config !== "string" && config.name !== undefined) {
            const cachedText = statementState.statements.get(config.name);
            if (cachedText !== undefined) {
              statementState.statements.delete(config.name);
              statementState.statements.set(config.name, cachedText);
            } else if (statementState.statements.size >= maximumPreparedStatements) {
              const oldest = statementState.statements.keys().next().value!;
              await client.query(`DEALLOCATE ${quotePreparedStatementName(oldest)}`);
              statementState.statements.delete(oldest);
            }
          }
          const result =
            typeof config === "string"
              ? await client.query<Record<string, unknown>>(config)
              : await client.query<Record<string, unknown>, unknown[]>(queryConfig(config));
          if (typeof config !== "string" && config.name !== undefined) {
            statementState.statements.set(config.name, config.text);
          }
          const text = typeof config === "string" ? config : config.text;
          if (changesPreparedStatementIdentity(text)) preparedGeneration += 1;
          return { rows: result.rows };
        } catch (error) {
          throw normalizePostgresAdapterError(error);
        }
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
      if (typeof config !== "string" && config.name !== undefined) {
        let client: PostgresClientLike;
        try {
          client = wrapClient(await pool.connect());
        } catch (error) {
          throw normalizePostgresAdapterError(error);
        }
        let failure: unknown;
        try {
          return await client.query(config);
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          client.release(failure instanceof Error ? failure : failure === undefined ? undefined : true);
        }
      }
      try {
        const result =
          typeof config === "string"
            ? await pool.query<Record<string, unknown>>(config)
            : await pool.query<Record<string, unknown>, unknown[]>(queryConfig(config));
        const text = typeof config === "string" ? config : config.text;
        if (changesPreparedStatementIdentity(text)) preparedGeneration += 1;
        return { rows: result.rows };
      } catch (error) {
        throw normalizePostgresAdapterError(error);
      }
    },
    async ensureCursor(): Promise<void> {
      await loadCursor();
    },
    async ensureCopy(): Promise<void> {
      await loadCopyStreams();
    },
    async connect(): Promise<PostgresClientLike> {
      try {
        return wrapClient(await pool.connect());
      } catch (error) {
        throw normalizePostgresAdapterError(error);
      }
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}

export async function createPgDatabase(options: PgOptions): Promise<PostgresDatabase> {
  validatePoolConfig(options.poolConfig);
  if ((options.extensionManifests?.length ?? 0) > 0 && options.compatibilitySnapshot === undefined) {
    throw new TypeError("PostgreSQL runtime extension manifests require a compatibilitySnapshot file");
  }
  const snapshot =
    options.compatibilitySnapshot === undefined
      ? undefined
      : parsePostgresRuntimeSnapshot(JSON.parse(await readFile(options.compatibilitySnapshot, "utf8")));
  const resolvedConnectionString = await connectionString(options.connectionString);
  validateConnectionStringQueryTimeout(resolvedConnectionString);
  const driver = await loadPgDriver();
  const { Pool } = driver;
  const pool = new Pool({ ...options.poolConfig, connectionString: resolvedConnectionString });
  try {
    let codecs: readonly PostgresRuntimeCodec[] = [];
    if (snapshot !== undefined) {
      const evidence = await readPgRuntimeServerEvidence(pool as unknown as PgRuntimeEvidenceQueryable);
      validatePostgresRuntimeCompatibility(snapshot, evidence, options.typePolicy);
      if ((options.extensionManifests?.length ?? 0) > 0) {
        const extensions = resolvePostgresExtensionManifests(snapshot, options.extensionManifests ?? []);
        if (extensions.issues.length > 0) throw new PostgresExtensionResolutionError(extensions.issues);
        codecs = await resolvePgRuntimeCodecs(pool as unknown as PgRuntimeEvidenceQueryable, extensions.codecs);
      }
    }
    return createPostgresDatabase({
      pool: adaptPgPool(pool, options.cursorImporter, options.copyStreamsImporter, {
        ...(options.statementCacheSize === undefined ? {} : { statementCacheSize: options.statementCacheSize }),
      }),
      ownsPool: true,
      fallbackTypeParsers: driver.types,
      ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
      ...(options.decimal === undefined ? {} : { decimal: options.decimal }),
      ...(codecs.length === 0 ? {} : { codecs }),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
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
        ...(options.extensionManifests === undefined ? {} : { extensionManifests: options.extensionManifests }),
      });
      if (options.client !== undefined) return (await provider.introspect({})) as PostgresSchemaSnapshot;
      return (await provider.introspect({
        url: await connectionString(options.connectionString!),
      })) as PostgresSchemaSnapshot;
    },
  };
}
