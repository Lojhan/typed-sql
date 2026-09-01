import type { SqliteBuiltinDefinition, SqliteTableFunctionDefinition } from "./functions.js";

/** Optional families whose availability is established by compile-option evidence. */
export const SQLITE_EXTENSION_FUNCTIONS: readonly SqliteBuiltinDefinition[] = Object.freeze([
  {
    name: "SOUNDEX",
    kind: "scalar",
    arguments: [1, 1],
    result: "text-nullable",
    requiredCompileOption: "SOUNDEX",
    volatility: "immutable",
  },
  {
    name: "SQLITE_OFFSET",
    kind: "scalar",
    arguments: [1, 1],
    result: "integer-always-nullable",
    requiredCompileOption: "ENABLE_OFFSET_SQL_FUNC",
    volatility: "stable",
  },
  {
    name: "MEDIAN",
    kind: "aggregate",
    arguments: [1, 1],
    result: "real-nullable",
    availableSince: "3.51.0",
    requiredCompileOption: "ENABLE_PERCENTILE",
    volatility: "immutable",
  },
  {
    name: "PERCENTILE",
    kind: "aggregate",
    arguments: [2, 2],
    result: "real-nullable",
    availableSince: "3.51.0",
    requiredCompileOption: "ENABLE_PERCENTILE",
    volatility: "immutable",
  },
  {
    name: "PERCENTILE_CONT",
    kind: "aggregate",
    arguments: [2, 2],
    result: "real-nullable",
    availableSince: "3.51.0",
    requiredCompileOption: "ENABLE_PERCENTILE",
    volatility: "immutable",
  },
  {
    name: "PERCENTILE_DISC",
    kind: "aggregate",
    arguments: [2, 2],
    result: "real-nullable",
    availableSince: "3.51.0",
    requiredCompileOption: "ENABLE_PERCENTILE",
    volatility: "immutable",
  },
]);

export const SQLITE_EXTENSION_TABLE_FUNCTIONS: readonly SqliteTableFunctionDefinition[] = Object.freeze([
  {
    name: "CARRAY",
    arguments: [1, 3],
    result: "carray",
    availableSince: "3.51.0",
    requiredCompileOption: "ENABLE_CARRAY",
  },
]);
