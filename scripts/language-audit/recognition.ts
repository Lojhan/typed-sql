import type {
  DialectServerEvidence,
  ResolvedColumn,
  ResolvedParameter,
  SqlDiagnostic,
} from "../../packages/core/src/index.js";
import { grammarFor } from "./audit.js";
import { compareNativeDescription } from "./description.js";
import { hash } from "./inventory.mjs";

export type DiscoveredFunction = {
  name: string;
  kind?: string;
  arity?: number;
  arguments?: unknown;
  argument_types?: unknown;
  result_type_kind?: string;
  namespace?: string;
  returns_set?: boolean;
};

export function recognitionQueries(row: DiscoveredFunction, dialect?: string) {
  if (!/^[a-z_][a-z_0-9]*$/iu.test(row.name) || row.kind === "p" || row.result_type_kind === "p") return [];
  const types = Array.isArray(row.argument_types)
    ? row.argument_types
    : Array.isArray(row.arguments)
      ? row.arguments
      : undefined;
  if (types?.some((type) => typeof type !== "string" || !/^[a-z_0-9 "[\](),.]+$/iu.test(type))) return [];
  const arity = Number(row.arity);
  const counts = types ? [types.length] : Number.isSafeInteger(arity) && arity >= 0 ? [arity] : [0, 1, 2, 3, 4, 5];
  return counts
    .filter((count) => count <= 128)
    .map((count) => {
      let parameterIndex = 0;
      const argumentsSql = types
        ? types
            .map(
              (type) =>
                `CAST(${/\[\]$/u.test(type) ? (dialect === "postgres" ? "ARRAY[]" : "[0.5]") : dialect === "duckdb" ? `$${++parameterIndex}` : "NULL"} AS ${type})`,
            )
            .join(", ")
        : Array(count).fill("NULL").join(", ");
      const namespace = row.namespace && /^[a-z_][a-z_0-9]*$/iu.test(row.namespace) ? `${row.namespace}.` : "";
      const call = `${namespace}${row.name}(${argumentsSql})`;
      if (["table", "table_macro", "IF", "TF", "FT"].includes(row.kind ?? "") || row.returns_set)
        return `SELECT * FROM ${call}`;
      return `SELECT ${call}${row.kind === "window" || row.kind === "w" ? " OVER ()" : ""} AS value`;
    })
    .flatMap((sql, index) => {
      if (dialect !== "postgres" || !types?.length) return [sql];
      const count = counts[index]!;
      const namespace = row.namespace && /^[a-z_][a-z_0-9]*$/iu.test(row.namespace) ? `${row.namespace}.` : "";
      const call = `${namespace}${row.name}(${Array.from({ length: count }, (_value, position) => `$${position + 1}`).join(", ")})`;
      return [
        sql,
        row.returns_set ? `SELECT * FROM ${call}` : `SELECT ${call}${row.kind === "w" ? " OVER ()" : ""} AS value`,
      ];
    });
}

// The engine must accept a generated invocation before it can be evidence of a grammar gap.
// Preparation/description only: this runner never executes the discovered function calls.
export async function recognizeLive(
  dialect: string,
  version: string,
  rows: DiscoveredFunction[],
  prepare: (sql: string) => Promise<{ accepted: boolean; reason?: string; metadata?: unknown }>,
  server?: DialectServerEvidence,
) {
  const grammar = grammarFor(
    dialect,
    dialect === "mysql"
      ? version.split(".").slice(0, 2).join(".")
      : dialect === "postgres" || dialect === "sqlserver"
        ? version.split(".")[0]!
        : version,
    server,
  );
  const observations: {
    name: string;
    sql?: string;
    status: string;
    diagnostics?: string[];
    diagnosticDetails?: readonly SqlDiagnostic[];
    columns?: readonly ResolvedColumn[];
    parameters?: readonly ResolvedParameter[];
    reason?: string;
    nativeMetadata?: unknown;
    nativeTypeComparison?: ReturnType<typeof compareNativeDescription>;
  }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const candidates = recognitionQueries(row, dialect);
    if (!candidates.length) observations.push({ name: row.name, status: "native-invocation-unverified" });
    for (const sql of candidates) {
      if (seen.has(sql)) continue;
      seen.add(sql);
      let native: Awaited<ReturnType<typeof prepare>>;
      try {
        native = await prepare(sql);
      } catch (error) {
        throw new Error(`Native audit preparation failed for ${sql}: ${String((error as Error).message)}`, {
          cause: error,
        });
      }
      if (!native.accepted) {
        observations.push({
          name: row.name,
          sql,
          status: "native-rejected-generated-invocation",
          reason: native.reason ?? "native preparation rejected",
        });
        continue;
      }
      const result = grammar.analyze(sql);
      if ((result.parameters.length && !/\$\d+/u.test(sql)) || result.columns.some((column) => column.tsType === "any"))
        throw new Error(`Unsound analysis of generated parameter-free probe: ${sql}`);
      for (const range of [
        ...result.columns.map((column) => column.range),
        ...result.diagnostics.map((diagnostic) => diagnostic.range),
      ]) {
        if (
          !Number.isInteger(range.start) ||
          !Number.isInteger(range.end) ||
          range.start < 0 ||
          range.end < range.start ||
          range.end > sql.length
        )
          throw new Error(`Invalid analysis source span for ${sql}`);
      }
      const diagnostics = result.diagnostics.map((item) => `${item.code}: ${item.message}`);
      const comparison = compareNativeDescription(dialect, version, native.metadata, result);
      const unknown =
        !result.columns.length ||
        result.columns.some((column) => column.tsType === "unknown" || column.tsType === "any");
      observations.push({
        name: row.name,
        sql,
        status:
          comparison.status === "mismatch"
            ? "native-valid-type-mismatch"
            : diagnostics.length
              ? "native-valid-grammar-diagnostic"
              : unknown
                ? "native-valid-grammar-unknown"
                : "native-valid-recognition-only",
        diagnostics,
        diagnosticDetails: result.diagnostics,
        nativeMetadata: native.metadata ?? { status: "unavailable" },
        nativeTypeComparison: comparison,
        columns: result.columns,
        parameters: result.parameters,
      });
    }
  }
  return {
    scope:
      "native prepare/describe versus grammar recognition; full result, nullability, parameters and decoding semantics remain unverified",
    fingerprint: hash(observations),
    observations,
  };
}
