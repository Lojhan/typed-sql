import {
  applyDialectCapabilityStates,
  DIALECT_CONTRACT_VERSION,
  type DialectAnalysisContext,
  type DialectPlugin,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { duckDBParameterOccurrences, parseDuckDBStatement } from "./parser/parser.js";
import { DuckDBParseError, tokenize } from "./parser/tokenizer.js";
import { resolveDuckDBStatement } from "./resolver.js";
import { assertDuckDBSemanticEvidence } from "./settings.js";
import { type DuckDBSchemaSnapshot, parseDuckDBSchemaSnapshot } from "./snapshot.js";
import { DUCKDB_CAPABILITIES, duckDBVersionSupport, resolveDuckDBCapabilities } from "./support.js";
import {
  type DuckDBTypePolicy,
  defaultDuckDBTypePolicy,
  duckDBRuntimeValueType,
  validateDuckDBTypePolicy,
} from "./type-policy.js";
import { DUCKDB_DIALECT_VERSION } from "./version.js";
export interface DuckDBDialectOptions {
  readonly typePolicy?: DuckDBTypePolicy;
}
export function duckdb(options: DuckDBDialectOptions = {}): DialectPlugin<DuckDBSchemaSnapshot, DuckDBTypePolicy> {
  const policy = validateDuckDBTypePolicy(options.typePolicy ?? defaultDuckDBTypePolicy);
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "duckdb",
    grammarVersion: DUCKDB_DIALECT_VERSION,
    sqlModule: "@typed-sql/duckdb",
    runtimeSqlModule: "@typed-sql/duckdb/query",
    defaultTypePolicy: policy,
    runtimeValueType: duckDBRuntimeValueType,
    capabilities: DUCKDB_CAPABILITIES,
    resolveCapabilities: resolveDuckDBCapabilities,
    placeholder(index: number) {
      if (!Number.isSafeInteger(index) || index < 1 || index > 65535)
        throw new RangeError("DuckDB parameter index must be1–65535");
      return `$${index}`;
    },
    quoteIdentifier(name: string) {
      return `"${name.replaceAll('"', '""')}"`;
    },
    parameterOccurrences: duckDBParameterOccurrences,
    analyze(
      source: string,
      snapshot: DuckDBSchemaSnapshot,
      typePolicy = policy,
      _context: DialectAnalysisContext = {},
    ) {
      try {
        const engineVersion = snapshot.server?.versionKey ?? snapshot.version ?? "missing";
        if (snapshot.server?.product !== "duckdb" || duckDBVersionSupport(engineVersion) !== "supported")
          throw new DuckDBParseError(
            "Exact DuckDB analysis requires a qualified engine snapshot; this target is conservative",
            { start: 0, end: source.length, line: 1, column: 1 },
            "TSQ402",
          );
        try {
          assertDuckDBSemanticEvidence(snapshot.server);
        } catch (error) {
          throw new DuckDBParseError(
            error instanceof Error ? error.message : "Unsupported DuckDB semantic settings",
            { start: 0, end: source.length, line: 1, column: 1 },
            "TSQ402",
          );
        }
        if (
          snapshot.server?.versionKey !== "2.0.0" &&
          tokenize(source).some((token) => token.kind === "quoted" && token.text.startsWith("`"))
        )
          throw new DuckDBParseError(
            "Backtick identifiers require qualified DuckDB2.0 evidence",
            { start: 0, end: source.length, line: 1, column: 1 },
            "TSQ401",
          );
        const statement = parseDuckDBStatement(source),
          analysis = resolveDuckDBStatement(statement, snapshot, typePolicy);
        const result = applyDialectCapabilityStates(analysis, resolveDuckDBCapabilities(snapshot), statement.range);
        return result.diagnostics.some((item) => item.severity === "error")
          ? { ...result, semantics: unknownQuerySemantics(statement.range, "DuckDB analysis reported an error.") }
          : result;
      } catch (error) {
        if (!(error instanceof DuckDBParseError)) throw error;
        return {
          columns: [],
          parameters: [],
          diagnostics: [{ code: error.code, message: error.message, severity: "error" as const, range: error.range }],
          semantics: unknownQuerySemantics(error.range, "DuckDB statement could not be parsed."),
        };
      }
    },
    validateSnapshot: parseDuckDBSchemaSnapshot,
  });
}

export { type DuckDBBuiltinSignature, duckDBBuiltinCatalog, duckDBBuiltinSignatures } from "./catalog/index.js";
export { DuckDBValueError, decodeDuckDBValue } from "./codecs.js";
export type { DuckDBType, DuckDBTypeField } from "./native-types.js";
export { duckDBAsciiFold, formatDuckDBType, parseDuckDBType } from "./native-types.js";
export { sql } from "./query.js";
export type { DuckDBSchemaSnapshot } from "./snapshot.js";
export { parseDuckDBSchemaSnapshot } from "./snapshot.js";
export {
  DUCKDB_CAPABILITIES,
  DUCKDB_SUPPORT_POLICY,
  duckDBServerEvidence,
  duckDBVersionSupport,
  resolveDuckDBCapabilities,
} from "./support.js";
export type { DuckDBTypePolicy } from "./type-policy.js";
export {
  defaultDuckDBTypePolicy as typePolicy,
  defaultDuckDBTypePolicy,
  duckDBRuntimeType,
  duckDBTypeScript,
  mapDuckDBType,
  validateDuckDBTypePolicy,
} from "./type-policy.js";
export { DUCKDB_DIALECT_VERSION } from "./version.js";
