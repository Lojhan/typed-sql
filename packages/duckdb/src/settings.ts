import type { DialectServerEvidence } from "@typed-sql/core";
import { duckDBVersionSupport } from "./support.js";
export const DUCKDB_SEMANTIC_SETTINGS = Object.freeze([
  "TimeZone",
  "Calendar",
  "schema",
  "search_path",
  "preserve_identifier_case",
  "default_collation",
  "default_null_order",
  "default_order",
  "old_implicit_casting",
  "lambda_syntax",
  "integer_division",
]);
export function assertDuckDBSemanticEvidence(evidence: DialectServerEvidence, requireSettings = true): void {
  if (evidence.product !== "duckdb" || duckDBVersionSupport(evidence.versionKey) !== "supported")
    throw new TypeError("DuckDB runtime requires qualified engine evidence");
  const settings = evidence.settings;
  const require = (name: string, allowed: readonly unknown[]) => {
    if (settings[name] === undefined && !requireSettings) return;
    if (!allowed.includes(settings[name])) throw new TypeError(`Unsupported DuckDB semantic setting ${name}`);
  };
  require("integer_division", [false, "false"]);
  require("Calendar", ["gregorian"]);
  require("preserve_identifier_case", evidence.versionKey === "2.0.0" ? ["preserve_case"] : [true, "true"]);
  if (evidence.versionKey === "1.5.6") require("old_implicit_casting", [false, "false"]);
}
export function duckDBEvidenceDifferences(
  expected: DialectServerEvidence,
  actual: DialectServerEvidence,
): readonly string[] {
  const differences: string[] = [];
  if (expected.product !== actual.product) differences.push("product");
  if (expected.versionKey !== actual.versionKey) differences.push("versionKey");
  if (expected.features.join("\0") !== actual.features.join("\0")) differences.push("features");
  for (const name of new Set([...Object.keys(expected.settings), ...Object.keys(actual.settings)])) {
    if (expected.settings[name] !== actual.settings[name]) differences.push(`settings.${name}`);
  }
  return differences;
}
