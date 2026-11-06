import { createHash } from "node:crypto";
import type {
  DialectServerEvidence,
  LiveQueryVerificationEvidence,
  LiveQueryVerificationRequest,
  LiveQueryVerifier,
  QueryPlanCaptureRequest,
  QueryPlanEvidence,
  QueryPlanInspector,
  QueryPlanNode,
} from "@typed-sql/core";
import { encodeDuckDBValue } from "./codecs.js";
import { formatDuckDBType } from "./native-types.js";
import { duckDBParameterTransport } from "./parameter-transport.js";
import { duckDBParameterOccurrences, parseDuckDBStatement } from "./parser/parser.js";
import type { DuckDBBinding, DuckDBNativeStatement } from "./runtime.js";
import { type DuckDBTypePolicy, duckDBTypeScript, isKnownDuckDBType } from "./type-policy.js";
import { DUCKDB_DIALECT_VERSION } from "./version.js";

/** Operations share the owning database's lease, compatibility evidence and cleanup quarantine. */
export interface DuckDBServiceSession {
  server(): Promise<DialectServerEvidence>;
  describe<T>(sql: string, work: (statement: DuckDBNativeStatement) => Promise<T>): Promise<T>;
  rows(sql: string, bindings?: readonly DuckDBBinding[]): Promise<readonly (readonly unknown[])[]>;
}
export interface DuckDBServiceTransport {
  lease<T>(work: (session: DuckDBServiceSession) => Promise<T>): Promise<T>;
}
const fingerprint = (value: string) => {
  if (!/^sha256:[a-f\d]{64}$/u.test(value)) throw new TypeError("DuckDB services require a SHA-256 query fingerprint");
};
function statement(sql: string): void {
  const parsed = parseDuckDBStatement(sql);
  if (!["select", "insert", "update", "delete"].includes(parsed.kind))
    throw new TypeError("DuckDB services require a supported query statement");
}
const safe = async <T>(kind: string, work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch {
    // Native errors can embed the complete SQL and transient planning samples.
    throw new Error(`DuckDB ${kind} failed; inspect the query using the native driver outside proof capture`);
  }
};

export function createDuckDBLiveVerifier(
  transport: DuckDBServiceTransport,
  policy: DuckDBTypePolicy,
  typePolicyHash: string,
): LiveQueryVerifier {
  return Object.freeze({
    dialect: "duckdb",
    adapterVersion: DUCKDB_DIALECT_VERSION,
    typePolicyHash,
    server: () =>
      safe("verification evidence", () =>
        transport.lease(async (session) => {
          const server = await session.server();
          return { version: server.version, features: [...(server.features ?? [])].sort() };
        }),
      ),
    async verify(request: LiveQueryVerificationRequest): Promise<LiveQueryVerificationEvidence> {
      request = { ...request };
      fingerprint(request.fingerprint);
      return safe("verification", () =>
        transport.lease(async (session) => {
          statement(request.sql);
          return session.describe(request.sql, async (native) => {
            const unavailable: ("columns" | "parameters")[] = [];
            if (!native.columns) unavailable.push("columns");
            if (!native.parameters || native.parameters.some((type) => !type || !isKnownDuckDBType(type)))
              unavailable.push("parameters");
            return {
              columns: (native.columns ?? []).map((column, index) => ({
                index: index + 1,
                name: column.name,
                databaseType: formatDuckDBType(column.type),
                tsType: duckDBTypeScript(column.type, policy),
              })),
              parameters: (native.parameters ?? []).map((type, index) => ({
                index: index + 1,
                ...(type && isKnownDuckDBType(type)
                  ? { databaseType: formatDuckDBType(type), tsType: duckDBTypeScript(type, policy) }
                  : {}),
              })),
              ...(unavailable.length ? { unavailable } : {}),
            };
          });
        }),
      );
    },
    async close() {},
  });
}
const optimizerSettings = [
  "threads",
  "memory_limit",
  "default_order",
  "default_null_order",
  "disabled_optimizers",
  "enable_optimizer",
  "enable_profiling",
  "index_scan_max_count",
  "index_scan_percentage",
  "dynamic_or_filter_threshold",
  "late_materialization_max_rows",
  "nested_loop_join_threshold",
  "merge_join_threshold",
  "perfect_ht_threshold",
];
function plan(value: unknown): QueryPlanEvidence {
  if (typeof value !== "string" || value.length > 4 * 1024 * 1024)
    throw new TypeError("Invalid DuckDB structured plan");
  const roots: unknown = JSON.parse(value);
  if (!Array.isArray(roots)) throw new TypeError("Invalid DuckDB structured plan roots");
  const nodes: QueryPlanNode[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 128 || nodes.length >= 16384 || typeof value !== "object" || value === null)
      throw new TypeError("Invalid DuckDB structured plan node");
    const node = value as Record<string, unknown>;
    if (typeof node.name !== "string" || node.name.length > 1024 || !Array.isArray(node.children))
      throw new TypeError("Invalid DuckDB structured plan node fields");
    const extra =
      typeof node.extra_info === "object" && node.extra_info !== null
        ? (node.extra_info as Record<string, unknown>)
        : {};
    const cardinality = extra["Estimated Cardinality"];
    const rows = typeof cardinality === "number" || typeof cardinality === "string" ? Number(cardinality) : Number.NaN;
    const relation = extra.Table;
    // No expressions, filters, projections, constants, or parameter samples enter this inventory.
    nodes.push({
      kind: node.name.trim().replaceAll(/\s+/gu, "_"),
      ...(typeof relation === "string" && relation.length <= 4096 ? { relation } : {}),
      ...(Number.isFinite(rows) && rows >= 0 ? { estimatedRows: rows } : {}),
    });
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return { nodes, ...(nodes[0]?.estimatedRows !== undefined ? { estimatedRows: nodes[0].estimatedRows } : {}) };
}
export function createDuckDBPlanInspector(
  transport: DuckDBServiceTransport,
  policy: DuckDBTypePolicy,
): QueryPlanInspector {
  return Object.freeze({
    dialect: "duckdb",
    adapterVersion: DUCKDB_DIALECT_VERSION,
    parameterMode: "samples-required",
    environment: () =>
      safe("plan environment", () =>
        transport.lease(async (session) => {
          const server = await session.server();
          const settings = await session.rows(
            `SELECT name,COALESCE(value,'NULL') FROM duckdb_settings() WHERE name IN (${optimizerSettings.map((name) => `'${name}'`).join(",")}) ORDER BY name`,
          );
          const statistics = await session.rows(
            "SELECT database_name,schema_name,table_name,estimated_size,column_count,index_count,sql FROM duckdb_tables() ORDER BY database_name,schema_name,table_name",
          );
          return {
            version: server.version,
            settings: Object.fromEntries(
              settings.map((row) => {
                if (typeof row[0] !== "string" || typeof row[1] !== "string")
                  throw new TypeError("Invalid DuckDB optimizer evidence");
                return [row[0], row[1]];
              }),
            ),
            statisticsFingerprint: `sha256:${createHash("sha256")
              .update(
                JSON.stringify(statistics, (_, item: unknown) => (typeof item === "bigint" ? item.toString() : item)),
              )
              .digest("hex")}`,
          };
        }),
      ),
    async capture(request: QueryPlanCaptureRequest) {
      try {
        request = { ...request, ...(request.values === undefined ? {} : { values: structuredClone(request.values) }) };
      } catch {
        throw new TypeError("DuckDB planning samples must be cloneable application values");
      }
      fingerprint(request.fingerprint);
      if (
        !Number.isSafeInteger(request.parameterCount) ||
        request.parameterCount < 0 ||
        (request.values?.length ?? 0) !== request.parameterCount
      )
        throw new TypeError("DuckDB planning requires one transient sample per parameter");
      return safe("plan capture", () =>
        transport.lease(async (session) => {
          statement(request.sql);
          const targets = await session.describe(request.sql, async (native) => {
            if (
              !native.parameters ||
              native.parameters.length !== request.parameterCount ||
              native.parameters.some((type) => !type || !isKnownDuckDBType(type))
            )
              throw new TypeError("DuckDB planning requires native parameter target metadata");
            return native.parameters.map((type) => type!);
          });
          const transports = targets.map(duckDBParameterTransport);
          const bindings = targets.map((type, i) => ({
            type: transports[i]!.wireType,
            value: transports[i]!.encode(
              encodeDuckDBValue(request.values![i], type, policy, `planning parameter ${i + 1}`),
            ),
          }));
          let physicalSQL = request.sql;
          for (const occurrence of duckDBParameterOccurrences(request.sql).toReversed()) {
            if (occurrence.name || occurrence.index < 1 || occurrence.index > transports.length)
              throw new TypeError("Invalid DuckDB planning marker");
            physicalSQL =
              physicalSQL.slice(0, occurrence.range.start) +
              transports[occurrence.index - 1]!.placeholder(`$${occurrence.index}`) +
              physicalSQL.slice(occurrence.range.end);
            if (physicalSQL.length > 4 * 1024 * 1024) throw new RangeError("DuckDB planning SQL expansion limit");
          }
          const rows = await session.rows(`EXPLAIN (FORMAT JSON) ${physicalSQL}`, bindings);
          if (rows.length !== 1 || rows[0]?.[0] !== "physical_plan")
            throw new TypeError("Invalid DuckDB EXPLAIN response");
          return plan(rows[0][1]);
        }),
      );
    },
    async close() {},
  });
}
