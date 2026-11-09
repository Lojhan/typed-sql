import {
  applyDialectCapabilityStates,
  type DialectAnalysisContext,
  type DialectPlugin,
  unknownQuerySemantics,
} from "@typed-sql/core";
import type { DuckDBCatalogProvider } from "./catalog/provider.js";
import { parseDuckDBStatement } from "./parser/parser.js";
import { DuckDBParseError, tokenize } from "./parser/tokenizer.js";
import { duckdbProfile } from "./profile.js";
import { resolveDuckDBStatement } from "./resolver.js";
import { assertDuckDBSemanticEvidence } from "./settings.js";
import type { DuckDBSchemaSnapshot } from "./snapshot.js";
import { duckDBVersionSupport, resolveDuckDBCapabilities } from "./support.js";
import type { DuckDBTypePolicy } from "./type-policy.js";
export interface DuckDBDialectOptions {
  readonly typePolicy?: DuckDBTypePolicy;
}
export function createDuckDBDialect(
  catalog: DuckDBCatalogProvider,
  options: DuckDBDialectOptions = {},
  selectedVersion?: string,
): DialectPlugin<DuckDBSchemaSnapshot, DuckDBTypePolicy> {
  const profile = duckdbProfile(options),
    policy = profile.defaultTypePolicy;
  return Object.freeze({
    ...profile,
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
        if (selectedVersion !== undefined && engineVersion !== selectedVersion)
          throw new DuckDBParseError(
            `The selected DuckDB analyzer requires engine ${selectedVersion}`,
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
          tokenize(source).some(
            (token) => (token.kind === "quoted" && token.text.startsWith("`")) || token.modernEscapes,
          )
        )
          throw new DuckDBParseError(
            "Backtick identifiers and modern escape-string bytes require qualified DuckDB2.0 evidence",
            { start: 0, end: source.length, line: 1, column: 1 },
            "TSQ401",
          );
        const statement = parseDuckDBStatement(source),
          analysis = resolveDuckDBStatement(statement, snapshot, typePolicy, catalog);
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
    validateSnapshot(value: unknown) {
      const snapshot = profile.validateSnapshot(value);
      if (selectedVersion !== undefined && snapshot.server?.versionKey !== selectedVersion)
        throw new TypeError(`The selected DuckDB analyzer requires engine ${selectedVersion}`);
      return snapshot;
    },
  });
}
