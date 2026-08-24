import { parseSelect, SqlParseError, type SqlDiagnostic } from "@typed-sql/ast";
import { resolveSelect, rowTypeLiteral, type SchemaSnapshot } from "@typed-sql/schema";
import { extractStaticQueries, mapSqlRange, type ExtractedQuery } from "./scanner.js";

export interface CompiledQuery {
  readonly query: ExtractedQuery;
  readonly rowType: string;
}

export interface CompileSourceResult {
  readonly transformedSource: string;
  readonly queries: readonly CompiledQuery[];
  readonly diagnostics: readonly SqlDiagnostic[];
}

function mapDiagnostic(source: string, query: ExtractedQuery, diagnostic: SqlDiagnostic): SqlDiagnostic {
  return { ...diagnostic, range: mapSqlRange(source, query, diagnostic.range) };
}

export function compileSource(source: string, schema: SchemaSnapshot): CompileSourceResult {
  const extracted = extractStaticQueries(source);
  const compiled: CompiledQuery[] = [];
  const diagnostics: SqlDiagnostic[] = [];
  for (const query of extracted) {
    try {
      const statement = parseSelect(query.sql);
      const resolved = resolveSelect(statement, schema);
      diagnostics.push(...resolved.diagnostics.map((diagnostic) => mapDiagnostic(source, query, diagnostic)));
      compiled.push({ query, rowType: rowTypeLiteral(resolved.columns) });
    } catch (error) {
      if (!(error instanceof SqlParseError)) throw error;
      diagnostics.push({ code: error.code, message: error.message, severity: "error", range: mapSqlRange(source, query, error.range) });
    }
  }
  let transformedSource = source;
  for (const item of [...compiled].sort((a, b) => b.query.insertionPosition - a.query.insertionPosition)) {
    transformedSource = `${transformedSource.slice(0, item.query.insertionPosition)}<${item.rowType}>${transformedSource.slice(item.query.insertionPosition)}`;
  }
  return { transformedSource, queries: compiled, diagnostics };
}
