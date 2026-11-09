import type {
  DialectServerEvidence,
  ResolvedColumn,
  ResolvedParameter,
  SqlDiagnostic,
} from "../../packages/core/src/index.js";
import { grammarFor } from "./audit.js";
import { hash } from "./inventory.mjs";

import { type DiscoveredFunction, recognitionQueries } from "./queries.js";

export { type DiscoveredFunction, recognitionQueries } from "./queries.js";

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
  }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const candidates = recognitionQueries(row);
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
      if (result.parameters.length || result.columns.some((column) => column.tsType === "any"))
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
      const unknown =
        !result.columns.length ||
        result.columns.some((column) => column.tsType === "unknown" || column.tsType === "any");
      observations.push({
        name: row.name,
        sql,
        status: diagnostics.length
          ? "native-valid-grammar-diagnostic"
          : unknown
            ? "native-valid-grammar-unknown"
            : "native-valid-recognition-only",
        diagnostics,
        diagnosticDetails: result.diagnostics,
        nativeMetadata: native.metadata ?? { status: "unavailable" },
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
