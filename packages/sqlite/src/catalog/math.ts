import type { SqliteBuiltinDefinition } from "./functions.js";

const math = {
  kind: "scalar",
  result: "real-nullable",
  requiredCompileOption: "ENABLE_MATH_FUNCTIONS",
  volatility: "immutable",
} as const;

/** Optional mathematical SQL functions enabled by SQLITE_ENABLE_MATH_FUNCTIONS. */
export const SQLITE_MATH_FUNCTIONS: readonly SqliteBuiltinDefinition[] = Object.freeze([
  ...[
    "ACOS",
    "ACOSH",
    "ASIN",
    "ASINH",
    "ATAN",
    "ATANH",
    "CEIL",
    "CEILING",
    "COS",
    "COSH",
    "DEGREES",
    "EXP",
    "FLOOR",
    "LN",
    "LOG10",
    "LOG2",
    "RADIANS",
    "SIN",
    "SINH",
    "SQRT",
    "TAN",
    "TANH",
    "TRUNC",
  ].map((name): SqliteBuiltinDefinition => ({ name, arguments: [1, 1], ...math })),
  ...["ATAN2", "LOG", "MOD", "POW", "POWER"].map(
    (name): SqliteBuiltinDefinition => ({ name, arguments: [2, 2], ...math }),
  ),
  {
    name: "PI",
    kind: "scalar",
    arguments: [0, 0],
    result: "real",
    requiredCompileOption: "ENABLE_MATH_FUNCTIONS",
    volatility: "immutable",
  },
]);
