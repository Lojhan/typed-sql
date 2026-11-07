import { sqliteAsciiUpper } from "../identifier-case.js";
import { compareSqliteVersions, parseSqliteVersion, sqliteVersionSupport } from "../support.js";
import { SQLITE_DATE_TIME_FUNCTIONS } from "./date-time.js";
import { SQLITE_EXTENSION_FUNCTIONS } from "./extensions.js";
import { coreFunctions } from "./generated/policy.js";
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

/**
 * Reviewed SQLite core catalog for the supported language band. JSON, date/time,
 * math, and loadable-extension families are expanded by their dedicated catalog
 * modules; classification-only rows keep structural validation fail-closed.
 */
export const SQLITE_BUILTIN_FUNCTIONS: readonly SqliteBuiltinDefinition[] = Object.freeze([
  ...coreFunctions,
  ...SQLITE_JSON_FUNCTIONS,
  ...SQLITE_DATE_TIME_FUNCTIONS,
  ...SQLITE_MATH_FUNCTIONS,
  ...SQLITE_EXTENSION_FUNCTIONS,
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
    (definition) => definition.name === sqliteAsciiUpper(functionName) && definition.resolvable !== false,
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
    (definition) => definition.name === sqliteAsciiUpper(functionName) && definition.kind === "aggregate",
  );
}

export function isSqliteWindowFunction(functionName: string): boolean {
  return SQLITE_BUILTIN_FUNCTIONS.some(
    (definition) => definition.name === sqliteAsciiUpper(functionName) && definition.kind === "window",
  );
}

export function sqliteBuiltinVolatility(functionName: string): SqliteBuiltinDefinition["volatility"] | undefined {
  const normalized = sqliteAsciiUpper(functionName);
  const definition = SQLITE_BUILTIN_FUNCTIONS.find(({ name }) => name === normalized);
  if (definition === undefined) return undefined;
  return definition.volatility ?? "immutable";
}
