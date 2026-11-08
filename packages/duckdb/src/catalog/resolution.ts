import type { DuckDBType } from "../native-types.js";
import { duckDBCatalogForVersion } from "./index.js";
import { matchDuckDBBuiltin as match } from "./resolution-engine.js";
import type { DuckDBBuiltinSignature } from "./types.js";

export type { DuckDBBuiltinMatch } from "./resolution-engine.js";
export function matchDuckDBBuiltin(
  version: string,
  name: string,
  args: readonly DuckDBType[],
  candidates?: readonly DuckDBBuiltinSignature[],
) {
  return match(duckDBCatalogForVersion(version), name, args, candidates);
}
