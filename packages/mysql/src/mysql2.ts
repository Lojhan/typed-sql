import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { DatabaseObserver, LiveQueryVerifier, QueryPlanEvidence, QueryPlanInspector } from "@typed-sql/core";
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
import { defaultMySqlTypePolicy, isKnownMySqlType, type MySqlTypePolicy, mapMySqlType } from "./type-policy.js";

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
  readonly observer?: DatabaseObserver;
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

interface MySql2VerificationField {
  readonly name?: string;
  readonly columnType?: number;
  readonly type?: number;
  readonly columnLength?: number;
  readonly length?: number;
  readonly flags?: number | readonly string[];
}

interface MySql2VerificationStatement {
  readonly statement?: {
    readonly columns?: readonly MySql2VerificationField[];
    readonly parameters?: readonly MySql2VerificationField[];
  };
  close(): Promise<void>;
}

export interface MySql2LiveVerifierConnection {
  prepare(sql: string): Promise<MySql2VerificationStatement>;
  release(): void;
}

export interface MySql2LiveVerifierPool {
  query<Row extends Record<string, unknown>[]>(sql: string): Promise<readonly [Row, unknown]>;
  getConnection(): Promise<MySql2LiveVerifierConnection>;
  end(): Promise<void>;
}

export interface MySql2LiveVerifierOptions {
  readonly connectionUri?: string | (() => string | Promise<string>);
  readonly pool?: MySql2LiveVerifierPool;
  readonly poolConfig?: Omit<PoolOptions, "uri">;
  readonly typePolicy?: MySqlTypePolicy;
  readonly schema?: MySqlSchemaSnapshot;
  readonly driverImporter?: () => Promise<typeof import("mysql2/promise")>;
}

export interface MySql2PlanInspectorConnection {
  query<Row extends Record<string, unknown>[]>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<readonly [Row, unknown]>;
  release(): void;
}

export interface MySql2PlanInspectorPool {
  query<Row extends Record<string, unknown>[]>(sql: string): Promise<readonly [Row, unknown]>;
  getConnection(): Promise<MySql2PlanInspectorConnection>;
  end(): Promise<void>;
}

export interface MySql2PlanInspectorOptions {
  readonly connectionUri?: string | (() => string | Promise<string>);
  readonly pool?: MySql2PlanInspectorPool;
  readonly poolConfig?: Omit<PoolOptions, "uri">;
  readonly driverImporter?: () => Promise<typeof import("mysql2/promise")>;
}

interface Executable {
  execute(sql: string, values?: readonly unknown[]): Promise<readonly [unknown, (readonly FieldPacket[])?]>;
  query(sql: string, values?: readonly unknown[]): Promise<readonly [unknown, (readonly FieldPacket[])?]>;
}

interface MySql2LoadDataConnection {
  query(
    options: {
      readonly sql: string;
      readonly infileStreamFactory: (path: string) => Readable;
    },
    callback: (error: Error | null) => void,
  ): CallbackQuery;
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

const MYSQL_LIVE_VERIFIER_VERSION = "mysql-com-stmt-prepare-v1";
const mysqlTypeNames = new Map<number, string>([
  [0, "decimal"],
  [1, "tinyint"],
  [2, "smallint"],
  [3, "int"],
  [4, "float"],
  [5, "double"],
  [6, "null"],
  [7, "timestamp"],
  [8, "bigint"],
  [9, "mediumint"],
  [10, "date"],
  [11, "time"],
  [12, "datetime"],
  [13, "year"],
  [15, "varchar"],
  [16, "bit"],
  [245, "json"],
  [246, "decimal"],
  [247, "enum"],
  [248, "set"],
  [249, "tinyblob"],
  [250, "mediumblob"],
  [251, "longblob"],
  [252, "blob"],
  [253, "varchar"],
  [254, "char"],
  [255, "geometry"],
]);

function verificationField(
  field: MySql2VerificationField,
  index: number,
  policy: MySqlTypePolicy,
  schema?: MySqlSchemaSnapshot,
  exposeNullability = true,
) {
  const code = field.columnType ?? field.type ?? 6;
  const length = field.columnLength ?? field.length;
  const base = mysqlTypeNames.get(code) ?? `mysql-type-${code}`;
  const databaseType = code === 1 && length === 1 ? "tinyint(1)" : base;
  const flags = field.flags;
  return {
    index,
    ...(field.name === undefined || field.name.length === 0 ? {} : { name: field.name }),
    databaseType,
    ...(isKnownMySqlType(databaseType, schema) ? { tsType: mapMySqlType(databaseType, policy, schema) } : {}),
    ...(exposeNullability && typeof flags === "number" ? { nullable: (flags & 1) === 0 } : {}),
  };
}

/** Creates a lazy adapter over MySQL's binary COM_STMT_PREPARE metadata. */
export function createMySql2LiveVerifier(options: MySql2LiveVerifierOptions): LiveQueryVerifier {
  const ownsPool = options.pool === undefined;
  let poolPromise: Promise<MySql2LiveVerifierPool> | undefined;
  let serverPromise: ReturnType<LiveQueryVerifier["server"]> | undefined;
  const acquirePool = (): Promise<MySql2LiveVerifierPool> => {
    poolPromise ??= (async () => {
      if (options.pool !== undefined) return options.pool;
      if (options.connectionUri === undefined)
        throw new TypeError("MySQL live verification requires connectionUri or pool");
      const driver = await loadMySql2Driver(options.driverImporter);
      return driver.createPool({
        ...options.poolConfig,
        uri: await uri(options.connectionUri),
      }) as unknown as MySql2LiveVerifierPool;
    })();
    return poolPromise;
  };
  const server = async () => {
    serverPromise ??= (async () => {
      const pool = await acquirePool();
      const [rows] = await pool.query<
        Array<{ readonly version: string; readonly comment: string; readonly sqlMode: string }>
      >('SELECT VERSION() AS version, @@version_comment AS comment, @@sql_mode AS "sqlMode"');
      const row = rows[0];
      return {
        version: row?.version ?? "unknown",
        features: [`comment:${row?.comment ?? "unknown"}`, `sql-mode:${row?.sqlMode ?? ""}`],
      };
    })();
    return serverPromise;
  };
  return {
    dialect: "mysql",
    adapterVersion: MYSQL_LIVE_VERIFIER_VERSION,
    server,
    async verify(request) {
      const connection = await (await acquirePool()).getConnection();
      let statement: MySql2VerificationStatement | undefined;
      try {
        statement = await connection.prepare(request.sql);
        const native = statement.statement;
        if (native === undefined) {
          return { columns: [], parameters: [], unavailable: ["columns", "parameters"] };
        }
        const policy = options.typePolicy ?? defaultMySqlTypePolicy;
        return {
          columns: (native.columns ?? []).map((field, offset) =>
            verificationField(field, offset + 1, policy, options.schema),
          ),
          parameters: (native.parameters ?? []).map((field, offset) =>
            verificationField(field, offset + 1, policy, options.schema, false),
          ),
        };
      } finally {
        try {
          if (statement !== undefined) await statement.close();
        } finally {
          connection.release();
        }
      }
    },
    async close() {
      if (ownsPool && poolPromise !== undefined) await (await poolPromise).end();
    },
  };
}

const MYSQL_PLAN_INSPECTOR_VERSION = "mysql-explain-json-v1";

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function mysqlPlan(value: unknown): QueryPlanEvidence {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("MySQL returned an unsupported JSON plan");
  }
  const root = parsed as Readonly<Record<string, unknown>>;
  const nodes: QueryPlanEvidence["nodes"][number][] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (typeof item !== "object" || item === null) return;
    const record = item as Readonly<Record<string, unknown>>;
    const access = record.access_type;
    if (typeof access === "string" && access.length > 0) {
      const relation = record.table_name;
      const index = record.key ?? record.index_name;
      const estimatedRows = numberValue(
        record.rows_produced_per_join ?? record.rows_examined_per_scan ?? record.estimated_rows,
      );
      const cost =
        typeof record.cost_info === "object" && record.cost_info !== null
          ? numberValue((record.cost_info as Readonly<Record<string, unknown>>).prefix_cost)
          : numberValue(record.estimated_total_cost);
      nodes.push({
        kind: `access:${access}`,
        ...(typeof relation === "string" ? { relation } : {}),
        ...(typeof index === "string" ? { index } : {}),
        ...(estimatedRows === undefined ? {} : { estimatedRows }),
        ...(cost === undefined ? {} : { estimatedCost: cost }),
      });
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(root);
  const queryBlock =
    typeof root.query_block === "object" && root.query_block !== null
      ? (root.query_block as Readonly<Record<string, unknown>>)
      : undefined;
  const costInfo =
    typeof queryBlock?.cost_info === "object" && queryBlock.cost_info !== null
      ? (queryBlock.cost_info as Readonly<Record<string, unknown>>)
      : undefined;
  const totalCost = numberValue(costInfo?.query_cost ?? root.estimated_total_cost);
  const estimatedRows = numberValue(root.estimated_rows) ?? nodes[0]?.estimatedRows;
  return {
    ...(totalCost === undefined ? {} : { totalCost }),
    ...(estimatedRows === undefined ? {} : { estimatedRows }),
    nodes,
  };
}

/** Creates a lazy, non-executing adapter over MySQL structured EXPLAIN. */
export function createMySql2PlanInspector(options: MySql2PlanInspectorOptions): QueryPlanInspector {
  const ownsPool = options.pool === undefined;
  let poolPromise: Promise<MySql2PlanInspectorPool> | undefined;
  let environmentPromise: ReturnType<QueryPlanInspector["environment"]> | undefined;
  const acquirePool = (): Promise<MySql2PlanInspectorPool> => {
    poolPromise ??= (async () => {
      if (options.pool !== undefined) return options.pool;
      if (options.connectionUri === undefined) throw new TypeError("MySQL plan capture requires connectionUri or pool");
      const driver = await loadMySql2Driver(options.driverImporter);
      return driver.createPool({
        ...options.poolConfig,
        uri: await uri(options.connectionUri),
      }) as unknown as MySql2PlanInspectorPool;
    })();
    return poolPromise;
  };
  return {
    dialect: "mysql",
    adapterVersion: MYSQL_PLAN_INSPECTOR_VERSION,
    parameterMode: "samples-required",
    async environment() {
      environmentPromise ??= (async () => {
        const pool = await acquirePool();
        const [settings] = await pool.query<
          Array<{
            readonly version: string;
            readonly optimizerSwitch: string;
            readonly optimizerPruneLevel: string;
            readonly optimizerSearchDepth: string;
            readonly explainJsonFormatVersion: string;
          }>
        >(
          "SELECT VERSION() AS version, @@optimizer_switch AS optimizerSwitch, @@optimizer_prune_level AS optimizerPruneLevel, @@optimizer_search_depth AS optimizerSearchDepth, @@explain_json_format_version AS explainJsonFormatVersion",
        );
        const [statistics] = await pool.query<Array<Record<string, unknown>>>(
          "SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, CAST(SEQ_IN_INDEX AS CHAR) AS SEQ_IN_INDEX, CAST(CARDINALITY AS CHAR) AS CARDINALITY FROM information_schema.statistics WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
        );
        const [histograms] = await pool.query<Array<Record<string, unknown>>>(
          "SELECT SCHEMA_NAME, TABLE_NAME, COLUMN_NAME, HISTOGRAM FROM information_schema.column_statistics WHERE SCHEMA_NAME NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') ORDER BY SCHEMA_NAME, TABLE_NAME, COLUMN_NAME",
        );
        const row = settings[0];
        return {
          version: row?.version ?? "unknown",
          settings: {
            explain_json_format_version: String(row?.explainJsonFormatVersion ?? "unknown"),
            optimizer_prune_level: String(row?.optimizerPruneLevel ?? "unknown"),
            optimizer_search_depth: String(row?.optimizerSearchDepth ?? "unknown"),
            optimizer_switch: String(row?.optimizerSwitch ?? "unknown"),
          },
          statisticsFingerprint: `sha256:${createHash("sha256")
            .update(JSON.stringify([statistics, histograms]))
            .digest("hex")}`,
        };
      })();
      return environmentPromise;
    },
    async capture(request) {
      if (!/^sha256:[a-f\d]{64}$/u.test(request.fingerprint)) {
        throw new TypeError("MySQL plan capture requires a SHA-256 query fingerprint");
      }
      if (request.parameterCount > 0 && request.values === undefined) {
        throw new TypeError("MySQL plan capture requires explicit transient parameter samples");
      }
      if (request.values !== undefined && request.values.length !== request.parameterCount) {
        throw new TypeError("MySQL plan samples do not match the parameter count");
      }
      const connection = await (await acquirePool()).getConnection();
      try {
        const [rows] = await connection.query<Array<Record<string, unknown>>>(
          `EXPLAIN FORMAT=JSON ${request.sql}`,
          request.values,
        );
        return mysqlPlan(rows[0]?.EXPLAIN);
      } finally {
        connection.release();
      }
    },
    async close() {
      if (ownsPool && poolPromise !== undefined) await (await poolPromise).end();
    },
  };
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
    loadData: (statement, chunks) =>
      loadData(connection.connection as unknown as CallbackConnection, statement, chunks),
    beginTransaction: () => connection.beginTransaction(),
    commit: () => connection.commit(),
    rollback: () => connection.rollback(),
    destroy: () => connection.destroy(),
    release: () => connection.release(),
  };
}

function loadData(connection: CallbackConnection, statement: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
  const source = Readable.from(
    (async function* (): AsyncGenerator<Buffer> {
      for await (const chunk of chunks) yield Buffer.from(chunk);
    })(),
    { objectMode: false },
  );
  return new Promise((resolve, reject) => {
    const native = connection as unknown as MySql2LoadDataConnection;
    native.query(
      {
        sql: statement,
        infileStreamFactory(path) {
          if (path !== "typed-sql-stream") {
            throw new Error(`MySQL requested an unexpected local infile path: ${path}`);
          }
          return source;
        },
      },
      (error) => {
        if (error === null) resolve();
        else reject(error);
      },
    );
  });
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
    bulkLoad: true,
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
    ...(options.observer === undefined ? {} : { observer: options.observer }),
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
