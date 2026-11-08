import { duckDBCatalogForVersion } from "./index.js";
import { duckDBNamedArgumentOrder as order } from "./named-arguments-engine.js";
export function duckDBNamedArgumentOrder(
  version: string,
  name: string,
  names: readonly (string | undefined)[],
  quoted: boolean,
) {
  return order(duckDBCatalogForVersion(version), name, names, quoted);
}
