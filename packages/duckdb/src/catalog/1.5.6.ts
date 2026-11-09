// Generated from DuckDB 1.5.6 duckdb_functions() and can_cast_implicitly(); do not edit by hand.
// Source snapshot sha256:fb115cb3d24110b883045f0e8dd26c687a9c2db48c7995103b70cf0876f90e33
import { signatures as core } from "./core/1.5.6.js";
import { signatures as additional } from "./packs/1.5.6.js";
import type { DuckDBBuiltinSignature } from "./types.js";

export { implicitCasts } from "./core/1.5.6.js";
export const signatures: readonly DuckDBBuiltinSignature[] = [...core, ...additional].sort((a, b) =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
);
