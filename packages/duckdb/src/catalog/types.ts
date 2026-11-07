/** Exact signatures captured from a pinned engine's duckdb_functions() metadata. */
export type DuckDBBuiltinSignature = readonly [
  name: string,
  kind: string,
  parameters: readonly (string | null)[],
  returns: string | null,
  varargs: string | null,
  stability: string | null,
  sideEffects: boolean | null,
];

export interface DuckDBFormalParameter {
  readonly name: string | null;
  readonly passing: "positional-only" | "positional-or-named" | "named-only" | "variadic-positional";
  readonly optional: boolean;
}
