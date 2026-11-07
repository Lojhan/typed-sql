import type { ResolvedColumn, ResolvedParameter, SqlDiagnostic } from "../../packages/core/src/index.js";
import { formatDuckDBType, parseDuckDBType } from "../../packages/duckdb/src/native-types.js";
import { postgresCanonicalType } from "../../packages/postgres/src/type-resolution.js";
import { parseSqlServerNativeType } from "../../packages/sqlserver/src/native-types.js";

interface NativeDescription {
  columns?: readonly { nativeType?: string | null }[] | null;
  parameters?: readonly { index: number; nativeType: string | null }[];
  parameterCount?: number | null;
}

interface AnalyzedDescription {
  columns: readonly ResolvedColumn[];
  parameters: readonly ResolvedParameter[];
  diagnostics: readonly SqlDiagnostic[];
}

/** Compares native type identities; descriptors do not prove value-dependent nullability. */
export function compareNativeDescription(
  dialect: string,
  version: string,
  metadata: unknown,
  result: AnalyzedDescription,
) {
  if (!metadata || typeof metadata !== "object" || !["postgres", "duckdb", "sqlserver"].includes(dialect))
    return {
      status: "unverified",
      reason: "No qualified native type-identity comparison",
      differences: [] as string[],
    };
  if (result.diagnostics.length)
    return { status: "unverified", reason: "Grammar diagnostics retained in the audit", differences: [] as string[] };
  if (!result.columns.length)
    return { status: "unverified", reason: "Grammar result shape unavailable", differences: [] as string[] };
  const native = metadata as NativeDescription;
  if (
    !Array.isArray(native.columns) ||
    native.columns.some((column) => typeof column.nativeType !== "string" || !column.nativeType)
  )
    return { status: "unverified", reason: "Native result type description unavailable", differences: [] as string[] };
  const canonical = (name: string): string | undefined => {
    try {
      return dialect === "postgres"
        ? postgresCanonicalType(name, { formatVersion: 1, dialect, version, tables: {} })
        : dialect === "sqlserver"
          ? parseSqlServerNativeType(name)?.text
          : formatDuckDBType(parseDuckDBType(name));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return undefined;
    }
  };
  const differences: string[] = [];
  let incomplete = false;
  if (native.columns.length !== result.columns.length) differences.push("Result column count differs");
  native.columns.forEach((column, index) => {
    const actual = result.columns[index];
    if (!actual?.databaseType || actual.tsType === "unknown") {
      incomplete = true;
      return;
    }
    const expected = canonical(column.nativeType!);
    const analyzed = canonical(actual.databaseType);
    if (expected === undefined || analyzed === undefined) {
      incomplete = true;
      return;
    }
    if (analyzed !== expected)
      differences.push(`Column ${index + 1}: grammar ${actual.databaseType}; engine ${column.nativeType}`);
  });
  if (native.parameterCount != null && native.parameterCount !== result.parameters.length)
    differences.push(`Parameter count: grammar ${result.parameters.length}; engine ${native.parameterCount}`);
  for (const parameter of native.parameters ?? []) {
    const actual = result.parameters.find((value) => value.index === parameter.index);
    if (!parameter.nativeType || !actual?.databaseType || actual.tsType === "unknown") {
      incomplete = true;
      continue;
    }
    const expected = canonical(parameter.nativeType);
    const analyzed = canonical(actual.databaseType);
    if (expected === undefined || analyzed === undefined) {
      incomplete = true;
      continue;
    }
    if (analyzed !== expected)
      differences.push(`Parameter ${parameter.index}: grammar ${actual.databaseType}; engine ${parameter.nativeType}`);
  }
  return {
    status: differences.length ? "mismatch" : incomplete ? "unverified" : "native-identities-match",
    differences,
  };
}
