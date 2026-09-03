import type { SqliteBuiltinDefinition } from "./functions.js";

const unlimited = Number.POSITIVE_INFINITY;

/** SQLite date/time functions. Text modifiers are interpreted by the resolver. */
export const SQLITE_DATE_TIME_FUNCTIONS: readonly SqliteBuiltinDefinition[] = Object.freeze([
  { name: "DATE", kind: "scalar", arguments: [0, unlimited], result: "text-always-nullable", volatility: "stable" },
  { name: "TIME", kind: "scalar", arguments: [0, unlimited], result: "text-always-nullable", volatility: "stable" },
  { name: "DATETIME", kind: "scalar", arguments: [0, unlimited], result: "text-always-nullable", volatility: "stable" },
  { name: "JULIANDAY", kind: "scalar", arguments: [0, unlimited], result: "real-nullable", volatility: "stable" },
  { name: "UNIXEPOCH", kind: "scalar", arguments: [0, unlimited], result: "unixepoch", volatility: "stable" },
  { name: "STRFTIME", kind: "scalar", arguments: [1, unlimited], result: "text-always-nullable", volatility: "stable" },
  {
    name: "TIMEDIFF",
    kind: "scalar",
    arguments: [2, 2],
    result: "text-always-nullable",
    availableSince: "3.43.0",
    volatility: "stable",
  },
]);

export const SQLITE_CURRENT_TIME_KEYWORDS = Object.freeze(
  new Set(["CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP"]),
);
