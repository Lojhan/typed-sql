import { applyDialectCapabilityStates, type DialectAnalysis, unknownQuerySemantics } from "@typed-sql/core";
import type { PostgresSchemaSnapshot } from "@typed-sql/postgres";
import { resolvePostgresCapabilities } from "../../../../packages/postgres/src/capabilities.js";
import { parseStatement, SqlParseError } from "../../../../packages/postgres/src/parser/index.js";
import { resolveStatement } from "../../../../packages/postgres/src/resolver.js";
import { analyzePostgresSemantics } from "../../../../packages/postgres/src/semantics.js";
import { defaultPostgresTypePolicy, mapPostgresType } from "../../../../packages/postgres/src/type-policy.js";
import { POSTGRES_DIALECT_VERSION } from "../../../../packages/postgres/src/version.js";

export function analyzePostgres(sql: string, snapshot: PostgresSchemaSnapshot): DialectAnalysis {
  try {
    const statement = parseStatement(sql);
    const resolved = resolveStatement(statement, snapshot, { typePolicy: defaultPostgresTypePolicy });
    const analysis = {
      ...resolved,
      semantics: resolved.diagnostics.some(({ severity }) => severity === "error")
        ? unknownQuerySemantics(statement.range, "PostgreSQL semantic analysis reported an error.")
        : analyzePostgresSemantics(statement, snapshot),
    };
    return applyDialectCapabilityStates(analysis, resolvePostgresCapabilities(snapshot), statement.range);
  } catch (error) {
    if (!(error instanceof SqlParseError)) throw error;
    return {
      columns: [],
      parameters: [],
      diagnostics: [{ code: error.code, message: error.message, severity: "error", range: error.range }],
      semantics: unknownQuerySemantics(error.range, "The SQL could not be parsed by the PostgreSQL grammar."),
    };
  }
}

export type { PostgresSchemaSnapshot };
export { defaultPostgresTypePolicy, mapPostgresType, POSTGRES_DIALECT_VERSION };
