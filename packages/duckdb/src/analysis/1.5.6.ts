import { createDuckDBDialect, type DuckDBDialectOptions } from "../analysis-factory.js";
import { duckDBCatalog } from "../catalog/engines/1.5.6.js";
import { vocabulary } from "../vocabulary/generated/1.5.6.js";

export type { DuckDBDialectOptions } from "../analysis-factory.js";
/** Full offline semantics for one qualified engine; other engines require another explicit import. */
export function duckdb(options: DuckDBDialectOptions = {}) {
  return createDuckDBDialect(duckDBCatalog, options, "1.5.6", () => vocabulary);
}
