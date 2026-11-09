// Generated from DuckDB 2.0.0 duckdb_functions() and can_cast_implicitly(); do not edit by hand.
// Source snapshot sha256:7e333318c67712b9b727b01684750e9079c3e0dd0a7addb523ef4a1a0a683127
import { signatures as core } from "./core/2.0.0.js";
import { signatures as additional } from "./packs/2.0.0.js";
import type { DuckDBBuiltinSignature } from "./types.js";

export { implicitCasts } from "./core/2.0.0.js";
export const signatures: readonly DuckDBBuiltinSignature[] = [...core, ...additional].sort((a, b) =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
);
