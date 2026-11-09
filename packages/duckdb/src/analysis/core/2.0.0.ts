import { commonTypes, expressionTypes } from "../../catalog/common-2.0.0.js";
import { implicitCasts, knownBuiltinNames, selection, signatures } from "../../catalog/core/2.0.0.js";
import { createDuckDBCatalog } from "../../catalog/provider.js";
import { createDuckDBCoreDialect, type DuckDBCoreOptions } from "../../offline-packs.js";

export type { DuckDBCoreOptions, DuckDBOfflinePack } from "../../offline-packs.js";

const core = createDuckDBCatalog({
  version: "2.0.0",
  signatures,
  implicitCasts,
  commonTypes,
  expressionTypes,
  knownBuiltinNames,
  selection,
});
/** Bounded offline core; explicit installed packs can extend the selected engine. */
export function duckdb(options: DuckDBCoreOptions = {}) {
  return createDuckDBCoreDialect(core, "2.0.0", options);
}
