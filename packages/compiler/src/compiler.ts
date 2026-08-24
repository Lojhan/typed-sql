import {
  rowTypeLiteral,
  type DialectPlugin,
  type SchemaSnapshot,
  type SqlDiagnostic,
} from "@typed-sql/core";
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

export interface CompileSourceOptions<Snapshot extends SchemaSnapshot, Policy> {
  readonly source: string;
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
}

function mapDiagnostic(source: string, query: ExtractedQuery, diagnostic: SqlDiagnostic): SqlDiagnostic {
  return { ...diagnostic, range: mapSqlRange(source, query, diagnostic.range) };
}

export function compileSource<Snapshot extends SchemaSnapshot, Policy>(
  options: CompileSourceOptions<Snapshot, Policy>,
): CompileSourceResult {
  const { source, dialect, schema } = options;
  if (schema.dialect !== dialect.id) {
    throw new TypeError(`Dialect ${dialect.id} cannot compile a ${schema.dialect} schema snapshot`);
  }
  const extracted = extractStaticQueries(source, (index) => dialect.placeholder(index));
  const compiled: CompiledQuery[] = [];
  const diagnostics: SqlDiagnostic[] = [];
  for (const query of extracted) {
    const resolved = dialect.analyze(query.sql, schema, options.typePolicy);
    diagnostics.push(...resolved.diagnostics.map((diagnostic) => mapDiagnostic(source, query, diagnostic)));
    if (!resolved.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      compiled.push({ query, rowType: rowTypeLiteral(resolved.columns) });
    }
  }
  let transformedSource = source;
  for (const item of [...compiled].sort((a, b) => b.query.insertionPosition - a.query.insertionPosition)) {
    transformedSource = `${transformedSource.slice(0, item.query.insertionPosition)}<${item.rowType}>${transformedSource.slice(item.query.insertionPosition)}`;
  }
  return { transformedSource, queries: compiled, diagnostics };
}
