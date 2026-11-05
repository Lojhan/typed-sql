/** Exact signatures captured from a pinned engine's duckdb_functions() metadata. */
export type DuckDBBuiltinSignature = readonly [
  name: string,
  kind: string,
  parameters: readonly string[],
  returns: string | null,
  varargs: string | null,
  stability: string | null,
  sideEffects: boolean | null,
];
