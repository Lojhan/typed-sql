import { createHash } from "node:crypto";
import type { QueryPlanCaptureRequest, QueryPlanEvidence, QueryPlanInspector, QueryPlanNode } from "@typed-sql/core";
import {
  describeSqlServerParameters,
  type SqlServerLiveVerifierOptions,
  SqlServerServiceScope,
  sqlServerServiceEvidence,
  validateSqlServerVerificationProbe,
} from "./live-verifier.js";

export type SqlServerPlanInspectorOptions = Pick<SqlServerLiveVerifierOptions, "pool" | "ownsPool">;
export const sqlServerPlanQueries = Object.freeze({
  settings: "SELECT name,CONVERT(nvarchar(256),value) AS value FROM sys.database_scoped_configurations ORDER BY name",
  session: "SELECT CONVERT(nvarchar(32),@@OPTIONS) AS options",
  statistics:
    "SELECT s.object_id,s.stats_id,CONVERT(nvarchar(40),p.last_updated,126) AS last_updated,CONVERT(nvarchar(32),p.rows) AS rows,CONVERT(nvarchar(32),p.rows_sampled) AS rows_sampled,CONVERT(nvarchar(32),p.modification_counter) AS modification_counter FROM sys.stats s JOIN sys.objects o ON o.object_id=s.object_id OUTER APPLY sys.dm_db_stats_properties(s.object_id,s.stats_id) p WHERE o.is_ms_shipped=0 ORDER BY s.object_id,s.stats_id",
  on: "SET SHOWPLAN_XML ON",
  off: "SET SHOWPLAN_XML OFF",
});
const physicalOperators = new Set(
  "Adaptive Join|Assert|Bitmap|Clustered Index Delete|Clustered Index Insert|Clustered Index Merge|Clustered Index Scan|Clustered Index Seek|Clustered Index Update|Clustered Index Spool|Columnstore Index Scan|Columnstore Index Insert|Columnstore Index Update|Columnstore Index Delete|Collapse|Compute Scalar|Concatenation|Constant Scan|Deleted Scan|Distribute Streams|Eager Spool|Filter|Flow Distinct|Gather Streams|Hash Match|Index Delete|Index Insert|Index Scan|Index Seek|Index Spool|Index Update|Inserted Scan|Key Lookup|Lazy Spool|Log Row Scan|Merge Interval|Merge Join|Nested Loops|Online Index Insert|Parallelism|Parameter Table Scan|Print|Remote Delete|Remote Index Scan|Remote Index Seek|Remote Insert|Remote Query|Remote Scan|Remote Update|RID Lookup|Row Count Spool|Segment|Sequence|Sequence Project|Sort|Split|Stream Aggregate|Switch|Table Delete|Table Insert|Table Scan|Table Spool|Table Update|Table-valued function|Top|Top N Sort|UDX|Window Aggregate|Window Spool".split(
    "|",
  ),
);
function finite(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) throw new TypeError("Invalid SHOWPLAN estimate");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new TypeError("Invalid SHOWPLAN estimate");
  return parsed;
}
function entity(text: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/iu.test(text)) throw new TypeError("Unsupported SHOWPLAN entity");
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, (_match: string, name: string) => {
    const named: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[name]) return named[name];
    const code = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (
      !Number.isInteger(code) ||
      code <= 0 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff) ||
      (code < 32 && ![9, 10, 13].includes(code))
    )
      throw new TypeError("Invalid SHOWPLAN character");
    return String.fromCodePoint(code);
  });
}
function identifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith("[") || !value.endsWith("]") || value.length > 258)
    throw new TypeError("Unsupported SHOWPLAN identifier");
  const name = value.slice(1, -1).replaceAll("]]", "]");
  if (!name || name.includes("\0")) throw new TypeError("Invalid SHOWPLAN identifier");
  return name;
}
/** Bounded, non-expanding XML reader: DTDs/entities/CDATA are rejected, expressions are never retained. */
export function normalizeSqlServerShowplan(xml: unknown): QueryPlanEvidence {
  if (
    typeof xml !== "string" ||
    !xml ||
    xml.length > 8 * 1024 * 1024 ||
    !xml.isWellFormed() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(xml)
  )
    throw new TypeError("Unsupported SQL Server SHOWPLAN XML");
  const source = xml.replace(/^\uFEFF/u, "");
  const stack: { name: string; operator?: number }[] = [],
    nodes: QueryPlanNode[] = [];
  let offset = 0,
    tags = 0,
    roots = 0,
    plans = 0,
    statements = 0,
    totalCost: number | undefined,
    estimatedRows: number | undefined;
  while (offset < source.length) {
    const start = source.indexOf("<", offset);
    if (start < 0) {
      const tail = source.slice(offset);
      if (!stack.length && tail.trim()) throw new TypeError("Invalid SHOWPLAN trailing text");
      entity(tail);
      break;
    }
    if (!stack.length && source.slice(offset, start).trim()) throw new TypeError("Invalid SHOWPLAN leading text");
    entity(source.slice(offset, start));
    if (source.startsWith("<?xml", start) && roots === 0 && stack.length === 0) {
      const end = source.indexOf("?>", start);
      if (end < 0) throw new TypeError("Invalid SHOWPLAN XML declaration");
      offset = end + 2;
      continue;
    }
    if (source[start + 1] === "!" || source[start + 1] === "?")
      throw new TypeError("Unsupported SHOWPLAN XML declaration");
    let end = start + 1,
      quote: string | undefined;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
      else if (char === "<") throw new TypeError("Invalid SHOWPLAN XML tag");
    }
    if (end === source.length || end - start > 1024 * 1024 || ++tags > 100000)
      throw new TypeError("SHOWPLAN XML exceeds structural limits");
    const text = source.slice(start + 1, end),
      closing = text.startsWith("/"),
      empty = /\/\s*$/u.test(text);
    const match = /^\/?([A-Za-z_][\w.:-]*)/u.exec(text);
    if (!match) throw new TypeError("Invalid SHOWPLAN XML tag");
    const name = match[1]!,
      local = name.split(":").at(-1)!;
    if (closing) {
      if (!/^\/[A-Za-z_][\w.:-]*\s*$/u.test(text) || stack.pop()?.name !== name)
        throw new TypeError("Unbalanced SHOWPLAN XML");
      offset = end + 1;
      continue;
    }
    if (stack.length === 0) {
      if (local !== "ShowPlanXML" || ++roots !== 1) throw new TypeError("Unsupported SHOWPLAN root");
    }
    const attributes = new Map<string, string>();
    let remainder = text.slice(match[0].length).replace(/\/\s*$/u, "");
    while (remainder.trim()) {
      const attribute = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(remainder);
      if (!attribute || attributes.has(attribute[1]!) || attributes.size >= 128)
        throw new TypeError("Invalid SHOWPLAN XML attribute");
      const raw = attribute[2] ?? attribute[3]!;
      if (raw.includes("<")) throw new TypeError("Invalid SHOWPLAN XML attribute");
      attributes.set(attribute[1]!, entity(raw));
      remainder = remainder.slice(attribute[0].length);
    }
    if (
      local === "ShowPlanXML" &&
      attributes.get("xmlns") !== "http://schemas.microsoft.com/sqlserver/2004/07/showplan"
    )
      throw new TypeError("Unsupported SHOWPLAN namespace");
    if (local === "QueryPlan" && ++plans > 1) throw new TypeError("Multiple statement plans are unsupported");
    if (local === "StmtSimple" && attributes.get("StatementType") === "SELECT") {
      if (++statements > 1) throw new TypeError("Multiple statement plans are unsupported");
      totalCost = finite(attributes.get("StatementSubTreeCost"));
    }
    let operator: number | undefined;
    if (local === "RelOp") {
      const physical = attributes.get("PhysicalOp");
      if (!physical || !physicalOperators.has(physical) || nodes.length >= 16384)
        throw new TypeError("Unsupported SHOWPLAN operator");
      const rows = finite(attributes.get("EstimateRows")),
        cost = finite(attributes.get("EstimatedTotalSubtreeCost"));
      operator = nodes.length;
      nodes.push({
        kind: physical,
        ...(rows === undefined ? {} : { estimatedRows: rows }),
        ...(cost === undefined ? {} : { estimatedCost: cost }),
      });
      if (operator === 0) {
        estimatedRows = rows;
        totalCost ??= cost;
      }
    }
    if (local === "Object") {
      const parent = [...stack].reverse().find((frame) => frame.operator !== undefined)?.operator;
      if (parent !== undefined) {
        const table = identifier(attributes.get("Table")),
          schema = identifier(attributes.get("Schema")),
          index = identifier(attributes.get("Index"));
        const current = nodes[parent]!;
        if (current.relation === undefined && table)
          nodes[parent] = { ...current, relation: schema ? `${schema}.${table}` : table, ...(index ? { index } : {}) };
      }
    }
    if (!empty) {
      if (stack.length >= 256) throw new TypeError("SHOWPLAN XML nesting limit");
      stack.push({ name, ...(operator === undefined ? {} : { operator }) });
    }
    offset = end + 1;
  }
  if (stack.length || roots !== 1 || plans !== 1 || statements !== 1 || !nodes.length)
    throw new TypeError("Incomplete SQL Server SHOWPLAN");
  return Object.freeze({
    ...(totalCost === undefined ? {} : { totalCost }),
    ...(estimatedRows === undefined ? {} : { estimatedRows }),
    nodes: Object.freeze(nodes.map((node) => Object.freeze(node))),
  });
}

/** Generic, non-executing SHOWPLAN capture on an exclusively leased physical session. */
export function createSqlServerPlanInspector(options: SqlServerPlanInspectorOptions): QueryPlanInspector {
  const scope = new SqlServerServiceScope(options.pool, options.ownsPool);
  let profile: string | undefined;
  const attest = async (session: Parameters<Parameters<SqlServerServiceScope["run"]>[0]>[0]) => {
    const server = await sqlServerServiceEvidence(session);
    const identity = JSON.stringify(server);
    if (profile !== undefined && identity !== profile)
      throw new TypeError("SQL Server plan sessions have incompatible evidence");
    profile = identity;
    return server;
  };
  return {
    dialect: "sqlserver",
    adapterVersion: "sqlserver-showplan-xml-v1",
    parameterMode: "value-free",
    environment: () =>
      scope.run(async (session) => {
        const server = await attest(session),
          settings = await session.all(sqlServerPlanQueries.settings),
          sessionOptions = await session.all(sqlServerPlanQueries.session),
          statistics = await session.all(sqlServerPlanQueries.statistics);
        if (settings.length > 1024 || statistics.length > 100000 || sessionOptions.length !== 1)
          throw new TypeError("Invalid SQL Server optimizer evidence");
        const values: Record<string, string> = Object.fromEntries(
          Object.entries(server.settings)
            .filter(([key]) => !["databaseName", "edition"].includes(key))
            .map(([key, value]) => [key, String(value)]),
        );
        for (const row of settings) {
          if (
            typeof row.name !== "string" ||
            !/^[A-Z][A-Z0-9_]{0,127}$/u.test(row.name) ||
            !(typeof row.value === "string" || typeof row.value === "number") ||
            String(row.value).length > 256
          )
            throw new TypeError("Invalid SQL Server optimizer setting");
          Object.defineProperty(values, `database.${row.name}`, { value: String(row.value), enumerable: true });
        }
        const mask = sessionOptions[0]?.options;
        if (typeof mask !== "string" || !/^\d{1,10}$/u.test(mask))
          throw new TypeError("Invalid SQL Server session option mask");
        values.session_options = mask;
        const normalized = statistics.map((row) =>
          ["object_id", "stats_id", "last_updated", "rows", "rows_sampled", "modification_counter"].map((key) => {
            const value = row[key];
            if (value === null) return null;
            if ((typeof value !== "string" && typeof value !== "number") || String(value).length > 128)
              throw new TypeError("Invalid SQL Server statistics identity");
            return String(value);
          }),
        );
        return {
          version: server.version,
          settings: Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))),
          statisticsFingerprint: `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`,
        };
      }),
    async capture(request: QueryPlanCaptureRequest) {
      if (request.operation !== "read") throw new TypeError("SQL Server SHOWPLAN requires a read-only probe");
      const indices = validateSqlServerVerificationProbe(request);
      if (
        !Number.isSafeInteger(request.parameterCount) ||
        request.parameterCount !== indices.length ||
        request.values !== undefined
      )
        throw new TypeError("SQL Server generic plans require matching parameter counts without sample values");
      return scope.run(async (session, quarantine) => {
        await attest(session);
        const parameters = await describeSqlServerParameters(session, request.sql, indices);
        const declarations = parameters.fields
          .map((field) => `DECLARE @__typed_sql_${field.index} ${field.databaseType};`)
          .join("\n");
        let rows: readonly Record<string, unknown>[] | undefined;
        let failed = false;
        try {
          await session.all(sqlServerPlanQueries.on);
          rows = await session.all(`${declarations}${declarations ? "\n" : ""}${request.sql}`);
        } catch {
          failed = true;
        }
        try {
          await session.all(sqlServerPlanQueries.off);
        } catch {
          quarantine();
          failed = true;
        }
        if (failed || rows === undefined) throw new Error("SQL Server SHOWPLAN capture or cleanup failed");
        if (rows.length !== 1 || Object.keys(rows[0]!).length !== 1)
          throw new TypeError("SQL Server returned multiple plan results");
        return normalizeSqlServerShowplan(Object.values(rows[0]!)[0]);
      });
    },
    close: () => scope.close(),
  };
}
