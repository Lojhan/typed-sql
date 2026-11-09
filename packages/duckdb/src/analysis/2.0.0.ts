import { createDuckDBDialect, type DuckDBDialectOptions } from "../analysis-factory.js";
import { duckDBCatalog } from "../catalog/engines/2.0.0.js";

export type { DuckDBDialectOptions } from "../analysis-factory.js";
/** Full offline semantics for one qualified engine; other engines require another explicit import. */
export function duckdb(options: DuckDBDialectOptions = {}) {
  return createDuckDBDialect(duckDBCatalog, options, "2.0.0");
}
