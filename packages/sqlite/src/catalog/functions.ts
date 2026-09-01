import { compareSqliteVersions, parseSqliteVersion, sqliteVersionSupport } from "../support.js";
import { SQLITE_DATE_TIME_FUNCTIONS } from "./date-time.js";
import { SQLITE_EXTENSION_FUNCTIONS } from "./extensions.js";
import { SQLITE_JSON_FUNCTIONS } from "./json.js";
import { SQLITE_MATH_FUNCTIONS } from "./math.js";

export type SqliteBuiltinKind = "aggregate" | "scalar" | "window";

export type SqliteBuiltinResult =
  | "coalesce"
  | "blob"
  | "blob-nullable"
  | "concat"
  | "concat-ws"
  | "first-argument"
  | "first-argument-nullable"
  | "flexible-nullable"
  | "iif"
  | "integer"
  | "integer-always-nullable"
  | "integer-nullable"
  | "json-extract"
  | "jsonb-extract"
  | "lag-lead"
  | "nullif"
  | "numeric-from-arguments"
  | "numeric-nullable"
  | "real"
  | "real-nullable"
  | "text"
  | "text-always-nullable"
  | "text-nullable"
  | "unixepoch"
  | "unknown-nullable";

export interface SqliteBuiltinDefinition {
  readonly name: string;
  readonly kind: SqliteBuiltinKind;
  readonly arguments: readonly [minimum: number, maximum: number];
  readonly result: SqliteBuiltinResult;
  readonly availableSince?: string;
  readonly argumentPattern?: "even" | "odd";
  readonly omittedByCompileOption?: string;
  readonly requiredCompileOption?: string;
  readonly resolvable?: boolean;
  readonly volatility?: "immutable" | "stable" | "volatile";
}

export interface SqliteTableFunctionDefinition {
  readonly name: string;
  readonly arguments: readonly [minimum: number, maximum: number];
  readonly availableSince: string;
  readonly omittedByCompileOption?: string;
  readonly requiredCompileOption?: string;
  readonly result: "carray" | "json" | "jsonb";
}

const unlimited = Number.POSITIVE_INFINITY;

/**
 * Reviewed SQLite core catalog for the supported language band. JSON, date/time,
 * math, and loadable-extension families are expanded by their dedicated catalog
 * modules; classification-only rows keep structural validation fail-closed.
 */
export const SQLITE_BUILTIN_FUNCTIONS: readonly SqliteBuiltinDefinition[] = Object.freeze([
  { name: "ABS", kind: "scalar", arguments: [1, 1], result: "numeric-from-arguments" },
  { name: "AVG", kind: "aggregate", arguments: [1, 1], result: "real-nullable" },
  { name: "CHANGES", kind: "scalar", arguments: [0, 0], result: "integer" },
  { name: "CHAR", kind: "scalar", arguments: [1, unlimited], result: "text" },
  { name: "COALESCE", kind: "scalar", arguments: [2, unlimited], result: "coalesce" },
  { name: "COUNT", kind: "aggregate", arguments: [1, 1], result: "integer" },
  { name: "FORMAT", kind: "scalar", arguments: [1, unlimited], result: "text-nullable" },
  { name: "GLOB", kind: "scalar", arguments: [2, 2], result: "integer-nullable" },
  { name: "GROUP_CONCAT", kind: "aggregate", arguments: [1, 2], result: "text-always-nullable" },
  { name: "HEX", kind: "scalar", arguments: [1, 1], result: "text" },
  { name: "IFNULL", kind: "scalar", arguments: [2, 2], result: "coalesce" },
  { name: "IIF", kind: "scalar", arguments: [3, 3], result: "iif" },
  { name: "IIF", kind: "scalar", arguments: [2, 2], result: "iif", availableSince: "3.48.0" },
  { name: "IIF", kind: "scalar", arguments: [4, unlimited], result: "iif", availableSince: "3.49.0" },
  { name: "IF", kind: "scalar", arguments: [2, 3], result: "iif", availableSince: "3.48.0" },
  { name: "IF", kind: "scalar", arguments: [4, unlimited], result: "iif", availableSince: "3.49.0" },
  { name: "INSTR", kind: "scalar", arguments: [2, 2], result: "integer-nullable" },
  { name: "LAST_INSERT_ROWID", kind: "scalar", arguments: [0, 0], result: "integer" },
  { name: "LENGTH", kind: "scalar", arguments: [1, 1], result: "integer-nullable" },
  { name: "LIKE", kind: "scalar", arguments: [2, 3], result: "integer-nullable" },
  { name: "LIKELIHOOD", kind: "scalar", arguments: [2, 2], result: "first-argument" },
  { name: "LIKELY", kind: "scalar", arguments: [1, 1], result: "first-argument" },
  { name: "LOWER", kind: "scalar", arguments: [1, 1], result: "text-nullable" },
  { name: "LTRIM", kind: "scalar", arguments: [1, 2], result: "text-nullable" },
  { name: "MAX", kind: "aggregate", arguments: [1, 1], result: "first-argument-nullable" },
  { name: "MAX", kind: "scalar", arguments: [2, unlimited], result: "flexible-nullable" },
  { name: "MIN", kind: "aggregate", arguments: [1, 1], result: "first-argument-nullable" },
  { name: "MIN", kind: "scalar", arguments: [2, unlimited], result: "flexible-nullable" },
  { name: "NULLIF", kind: "scalar", arguments: [2, 2], result: "nullif" },
  { name: "OCTET_LENGTH", kind: "scalar", arguments: [1, 1], result: "integer-nullable", availableSince: "3.43.0" },
  { name: "PRINTF", kind: "scalar", arguments: [1, unlimited], result: "text-nullable" },
  { name: "QUOTE", kind: "scalar", arguments: [1, 1], result: "text" },
  { name: "RANDOM", kind: "scalar", arguments: [0, 0], result: "integer" },
  { name: "RANDOMBLOB", kind: "scalar", arguments: [1, 1], result: "blob" },
  { name: "REPLACE", kind: "scalar", arguments: [3, 3], result: "text-nullable" },
  { name: "ROUND", kind: "scalar", arguments: [1, 2], result: "real-nullable" },
  { name: "RTRIM", kind: "scalar", arguments: [1, 2], result: "text-nullable" },
  { name: "SIGN", kind: "scalar", arguments: [1, 1], result: "integer-nullable" },
  { name: "SQLITE_COMPILEOPTION_GET", kind: "scalar", arguments: [1, 1], result: "text-always-nullable" },
  { name: "SQLITE_COMPILEOPTION_USED", kind: "scalar", arguments: [1, 1], result: "integer" },
  { name: "SQLITE_SOURCE_ID", kind: "scalar", arguments: [0, 0], result: "text" },
  { name: "SQLITE_VERSION", kind: "scalar", arguments: [0, 0], result: "text" },
  {
    name: "STRING_AGG",
    kind: "aggregate",
    arguments: [2, 2],
    result: "text-always-nullable",
    availableSince: "3.44.0",
  },
  { name: "SUBSTR", kind: "scalar", arguments: [2, 3], result: "text-nullable" },
  { name: "SUBSTRING", kind: "scalar", arguments: [2, 3], result: "text-nullable" },
  { name: "SUM", kind: "aggregate", arguments: [1, 1], result: "numeric-nullable" },
  { name: "TOTAL", kind: "aggregate", arguments: [1, 1], result: "real" },
  { name: "TOTAL_CHANGES", kind: "scalar", arguments: [0, 0], result: "integer" },
  { name: "TRIM", kind: "scalar", arguments: [1, 2], result: "text-nullable" },
  { name: "TYPEOF", kind: "scalar", arguments: [1, 1], result: "text" },
  { name: "UNHEX", kind: "scalar", arguments: [1, 2], result: "blob-nullable", availableSince: "3.41.0" },
  { name: "UNICODE", kind: "scalar", arguments: [1, 1], result: "integer-nullable" },
  { name: "UNISTR", kind: "scalar", arguments: [1, 1], result: "text-nullable", availableSince: "3.50.0" },
  { name: "UNISTR_QUOTE", kind: "scalar", arguments: [1, 1], result: "text", availableSince: "3.50.0" },
  { name: "UNLIKELY", kind: "scalar", arguments: [1, 1], result: "first-argument" },
  { name: "UPPER", kind: "scalar", arguments: [1, 1], result: "text-nullable" },
  { name: "ZEROBLOB", kind: "scalar", arguments: [1, 1], result: "blob" },
  { name: "CONCAT", kind: "scalar", arguments: [1, unlimited], result: "concat", availableSince: "3.44.0" },
  { name: "CONCAT_WS", kind: "scalar", arguments: [2, unlimited], result: "concat-ws", availableSince: "3.44.0" },

  ...SQLITE_JSON_FUNCTIONS,
  ...SQLITE_DATE_TIME_FUNCTIONS,
  ...SQLITE_MATH_FUNCTIONS,
  ...SQLITE_EXTENSION_FUNCTIONS,

  { name: "CUME_DIST", kind: "window", arguments: [0, 0], result: "real" },
  { name: "DENSE_RANK", kind: "window", arguments: [0, 0], result: "integer" },
  { name: "FIRST_VALUE", kind: "window", arguments: [1, 1], result: "first-argument-nullable" },
  { name: "LAG", kind: "window", arguments: [1, 3], result: "lag-lead" },
  { name: "LAST_VALUE", kind: "window", arguments: [1, 1], result: "first-argument-nullable" },
  { name: "LEAD", kind: "window", arguments: [1, 3], result: "lag-lead" },
  { name: "NTH_VALUE", kind: "window", arguments: [2, 2], result: "first-argument-nullable" },
  { name: "NTILE", kind: "window", arguments: [1, 1], result: "integer" },
  { name: "PERCENT_RANK", kind: "window", arguments: [0, 0], result: "real" },
  { name: "RANK", kind: "window", arguments: [0, 0], result: "integer" },
  { name: "ROW_NUMBER", kind: "window", arguments: [0, 0], result: "integer" },

  // Loading extensions is connection state, not a compile-time capability.
  { name: "LOAD_EXTENSION", kind: "scalar", arguments: [1, 2], result: "unknown-nullable", resolvable: false },
]);

export type SqliteBuiltinResolution =
  | { readonly status: "exact"; readonly definition: SqliteBuiltinDefinition }
  | { readonly status: "arity"; readonly definitions: readonly SqliteBuiltinDefinition[] }
  | { readonly status: "compile-evidence-required"; readonly option: string }
  | { readonly status: "compile-option-unavailable"; readonly option: string }
  | { readonly status: "evidence-required"; readonly since: string }
  | { readonly status: "outside-supported-version"; readonly version: string }
  | { readonly status: "unavailable"; readonly since: string }
  | { readonly status: "unknown" };

function matchesArity(definition: SqliteBuiltinDefinition, arity: number): boolean {
  if (arity < definition.arguments[0] || arity > definition.arguments[1]) return false;
  if (definition.argumentPattern === "even") return arity % 2 === 0;
  if (definition.argumentPattern === "odd") return arity % 2 === 1;
  return true;
}

function hasCompileOption(features: readonly string[], option: string): boolean {
  return features.some((feature) => feature === option || feature.startsWith(`${option}=`));
}

function compileAvailability(
  definition: SqliteBuiltinDefinition,
  features: readonly string[] | undefined,
): SqliteBuiltinResolution | undefined {
  const compileOption = definition.requiredCompileOption ?? definition.omittedByCompileOption;
  if (compileOption === undefined) return undefined;
  if (features === undefined) return { status: "compile-evidence-required", option: compileOption };
  if (
    (definition.requiredCompileOption !== undefined && !hasCompileOption(features, definition.requiredCompileOption)) ||
    (definition.omittedByCompileOption !== undefined && hasCompileOption(features, definition.omittedByCompileOption))
  )
    return { status: "compile-option-unavailable", option: compileOption };
  return undefined;
}

export function resolveSqliteBuiltin(
  functionName: string,
  arity: number,
  version: string | undefined,
  features?: readonly string[],
): SqliteBuiltinResolution {
  const named = SQLITE_BUILTIN_FUNCTIONS.filter(
    (definition) => definition.name === functionName.toUpperCase() && definition.resolvable !== false,
  );
  if (named.length === 0) return { status: "unknown" };
  const matching = named.filter((definition) => matchesArity(definition, arity));
  if (matching.length === 0) return { status: "arity", definitions: named };
  const gated = matching.filter(
    (definition): definition is SqliteBuiltinDefinition & { readonly availableSince: string } =>
      definition.availableSince !== undefined,
  );
  const earliest = gated
    .map((definition) => definition.availableSince!)
    .sort((left, right) => compareSqliteVersions(parseSqliteVersion(left)!, parseSqliteVersion(right)!))[0];
  if (version === undefined || parseSqliteVersion(version) === undefined) {
    const ungated = matching.find((definition) => definition.availableSince === undefined);
    if (ungated !== undefined)
      return compileAvailability(ungated, features) ?? { status: "exact", definition: ungated };
    if (earliest === undefined) return { status: "unknown" };
    return { status: "evidence-required", since: earliest };
  }
  const actual = parseSqliteVersion(version)!;
  const available = matching.find(
    (definition) =>
      definition.availableSince === undefined ||
      compareSqliteVersions(actual, parseSqliteVersion(definition.availableSince)!) >= 0,
  );
  if (available === undefined && earliest !== undefined) return { status: "unavailable", since: earliest };
  const support = sqliteVersionSupport(version);
  if (support === "below-supported" || support === "newer-than-tested" || support === "prerelease")
    return { status: "outside-supported-version", version };
  if (available === undefined) return { status: "unknown" };
  return compileAvailability(available, features) ?? { status: "exact", definition: available };
}

export function isSqliteAggregateFunction(functionName: string): boolean {
  return SQLITE_BUILTIN_FUNCTIONS.some(
    (definition) => definition.name === functionName.toUpperCase() && definition.kind === "aggregate",
  );
}

export function isSqliteWindowFunction(functionName: string): boolean {
  return SQLITE_BUILTIN_FUNCTIONS.some(
    (definition) => definition.name === functionName.toUpperCase() && definition.kind === "window",
  );
}

export function sqliteBuiltinVolatility(functionName: string): SqliteBuiltinDefinition["volatility"] | undefined {
  const normalized = functionName.toUpperCase();
  const definition = SQLITE_BUILTIN_FUNCTIONS.find(({ name }) => name === normalized);
  if (definition === undefined) return undefined;
  if (["CHANGES", "LAST_INSERT_ROWID", "LOAD_EXTENSION", "RANDOM", "RANDOMBLOB", "TOTAL_CHANGES"].includes(normalized))
    return "volatile";
  return definition.volatility ?? "immutable";
}
