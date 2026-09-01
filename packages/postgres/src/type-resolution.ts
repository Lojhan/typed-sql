import type { SchemaSnapshot, TypeSnapshot } from "@typed-sql/schema";
import {
  type PostgresCastContext,
  type PostgresTypeCategory,
  postgresCatalogCanCast,
  postgresCatalogOperatorRule,
  postgresCatalogType,
  postgresCoreCatalogForSchema,
} from "./catalog/index.js";

const comparisonOperators = new Set([
  "<",
  "<=",
  "=",
  ">",
  ">=",
  "!=",
  "<>",
  "IS DISTINCT FROM",
  "IS NOT DISTINCT FROM",
]);
const patternOperators = new Set([
  "LIKE",
  "NOT LIKE",
  "ILIKE",
  "NOT ILIKE",
  "SIMILAR TO",
  "NOT SIMILAR",
  "~",
  "~*",
  "!~",
  "!~*",
]);

const simplePolymorphicTypes = new Set([
  "anyelement",
  "anyarray",
  "anynonarray",
  "anyenum",
  "anyrange",
  "anymultirange",
]);
const compatiblePolymorphicTypes = new Set([
  "anycompatible",
  "anycompatiblearray",
  "anycompatiblenonarray",
  "anycompatiblerange",
  "anycompatiblemultirange",
]);

export interface PostgresCandidate<Value> {
  readonly value: Value;
  readonly argumentTypes: readonly string[];
  readonly resultType: string;
}

export interface PostgresCandidateMatch<Value> {
  readonly kind: "selected";
  readonly candidate: Value;
  readonly argumentTypes: readonly string[];
  readonly resultType: string;
}

export type PostgresCandidateResolution<Value> =
  | PostgresCandidateMatch<Value>
  | { readonly kind: "ambiguous" | "none" };

export type PostgresOperatorResolution = PostgresCandidateResolution<string>;

interface TypeBindings {
  simple?: string;
  simpleArray?: string;
  simpleRange?: string;
  simpleMultirange?: string;
  compatible?: string;
  compatibleArray?: string;
  compatibleRange?: string;
  compatibleMultirange?: string;
}

interface RankedCandidate<Value> extends PostgresCandidateMatch<Value> {
  readonly exact: number;
  readonly preferred: number;
  readonly unknownString: number;
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\(\d+(?:,\s*\d+)?\)/gu, "")
    .replace(/\s+/gu, " ");
}

function schemaTypes(schema?: SchemaSnapshot): readonly TypeSnapshot[] {
  return schema?.formatVersion === 2 ? Object.values(schema.types) : [];
}

function typeEvidence(databaseType: string, schema?: SchemaSnapshot): TypeSnapshot | undefined {
  const normalized = normalize(databaseType);
  return schemaTypes(schema).find(
    (type) =>
      normalize(type.databaseType) === normalized ||
      normalize(type.identity) === normalized ||
      normalize(`${type.schema === undefined ? "" : `${type.schema}.`}${type.name}`) === normalized,
  );
}

/** Canonical PostgreSQL type identity for overload and coercion decisions. */
export function postgresCanonicalType(databaseType: string, schema?: SchemaSnapshot): string {
  const normalized = normalize(databaseType);
  if (normalized.endsWith("[]")) {
    return `${postgresCanonicalType(normalized.slice(0, -2), schema)}[]`;
  }
  return postgresCatalogType(normalized, schema)?.name ?? typeEvidence(normalized, schema)?.databaseType ?? normalized;
}

function baseType(databaseType: string, schema?: SchemaSnapshot): string {
  const canonical = postgresCanonicalType(databaseType, schema);
  const evidence = typeEvidence(canonical, schema);
  if (evidence?.kind !== "domain") return canonical;
  const base = schemaTypes(schema).find((type) => type.identity === evidence.baseTypeIdentity);
  return postgresCanonicalType(base?.databaseType ?? evidence.baseTypeIdentity, schema);
}

function category(databaseType: string, schema?: SchemaSnapshot): PostgresTypeCategory | undefined {
  const canonical = baseType(databaseType, schema);
  if (canonical.endsWith("[]")) return "array";
  const catalogType = postgresCatalogType(canonical, schema);
  if (catalogType !== undefined) return catalogType.category;
  const evidence = typeEvidence(canonical, schema);
  if (evidence?.kind === "enum") return "enum";
  if (evidence?.kind === "composite") return "composite";
  if (evidence?.kind === "range" || evidence?.kind === "multirange") return "range";
  return evidence === undefined ? undefined : "user";
}

function isPreferred(databaseType: string, schema?: SchemaSnapshot): boolean {
  return postgresCatalogType(baseType(databaseType, schema), schema)?.preferred ?? false;
}

function elementType(databaseType: string, schema?: SchemaSnapshot): string | undefined {
  const canonical = postgresCanonicalType(databaseType, schema);
  if (canonical.endsWith("[]")) return canonical.slice(0, -2);
  const evidence = typeEvidence(canonical, schema);
  if (evidence?.kind !== "collection") return undefined;
  const element = schemaTypes(schema).find((type) => type.identity === evidence.elementTypeIdentity);
  return element === undefined ? undefined : postgresCanonicalType(element.databaseType, schema);
}

function rangeSubtype(databaseType: string, schema?: SchemaSnapshot): string | undefined {
  const evidence = typeEvidence(databaseType, schema);
  if (evidence?.kind !== "range" && evidence?.kind !== "multirange") return undefined;
  const subtype = schemaTypes(schema).find((type) => type.identity === evidence.subtypeIdentity);
  return subtype === undefined ? undefined : postgresCanonicalType(subtype.databaseType, schema);
}

/** PostgreSQL common-type selection used by compatible polymorphic inputs. */
export function postgresCommonType(
  databaseTypes: readonly (string | undefined)[],
  schema?: SchemaSnapshot,
): string | undefined {
  const known = databaseTypes
    .filter((value): value is string => value !== undefined)
    .map((value) => baseType(value, schema));
  if (known.length === 0) return "text";
  if (known.every((value) => value === known[0])) return known[0];
  const firstCategory = category(known[0]!, schema);
  if (firstCategory === undefined || known.some((value) => category(value, schema) !== firstCategory)) return undefined;
  let candidate = known[0]!;
  for (const value of known.slice(1)) {
    if (candidate === value) continue;
    const candidateToValue = postgresCatalogCanCast(candidate, value, "implicit", schema);
    const valueToCandidate = postgresCatalogCanCast(value, candidate, "implicit", schema);
    if (!candidateToValue && !valueToCandidate) return undefined;
    if (candidateToValue && !valueToCandidate) candidate = value;
    if (isPreferred(candidate, schema)) break;
  }
  return known.every((value) => postgresCatalogCanCast(value, candidate, "implicit", schema)) ? candidate : undefined;
}

export function postgresCanCoerce(
  source: string,
  target: string,
  context: PostgresCastContext,
  schema?: SchemaSnapshot,
): boolean {
  const sourceType = baseType(source, schema);
  const targetType = baseType(target, schema);
  if (sourceType.endsWith("[]") && targetType.endsWith("[]")) {
    return postgresCanCoerce(sourceType.slice(0, -2), targetType.slice(0, -2), context, schema);
  }
  if (
    context === "explicit" &&
    category(sourceType, schema) !== undefined &&
    category(targetType, schema) !== undefined &&
    (category(sourceType, schema) === "string" || category(targetType, schema) === "string")
  ) {
    return true;
  }
  return postgresCatalogCanCast(sourceType, targetType, context, schema);
}

function bindExact(binding: string | undefined, value: string): string | false {
  return binding === undefined || binding === value ? value : false;
}

function bindPolymorphic(
  declared: string,
  actual: string | undefined,
  bindings: TypeBindings,
  compatibleInputs: string[],
  schema?: SchemaSnapshot,
): boolean {
  if (actual === undefined) return true;
  const canonical = postgresCanonicalType(actual, schema);
  if (simplePolymorphicTypes.has(declared)) {
    if (declared === "anyarray") {
      const element = elementType(canonical, schema);
      if (element === undefined) return false;
      const array = bindExact(bindings.simpleArray, canonical);
      const simple = bindExact(bindings.simple, element);
      if (array === false || simple === false) return false;
      bindings.simpleArray = array;
      bindings.simple = simple;
      return true;
    }
    if (declared === "anyrange" || declared === "anymultirange") {
      const subtype = rangeSubtype(canonical, schema);
      if (subtype === undefined) return false;
      const key = declared === "anyrange" ? "simpleRange" : "simpleMultirange";
      const range = bindExact(bindings[key], canonical);
      const simple = bindExact(bindings.simple, subtype);
      if (range === false || simple === false) return false;
      bindings[key] = range;
      bindings.simple = simple;
      return true;
    }
    if (declared === "anynonarray" && elementType(canonical, schema) !== undefined) return false;
    if (declared === "anyenum" && category(canonical, schema) !== "enum") return false;
    const simple = bindExact(bindings.simple, canonical);
    if (simple === false) return false;
    bindings.simple = simple;
    return true;
  }
  if (!compatiblePolymorphicTypes.has(declared)) return false;
  if (declared === "anycompatiblearray") {
    const element = elementType(canonical, schema);
    if (element === undefined) return false;
    compatibleInputs.push(element);
    bindings.compatibleArray = canonical;
    return true;
  }
  if (declared === "anycompatiblerange" || declared === "anycompatiblemultirange") {
    const subtype = rangeSubtype(canonical, schema);
    if (subtype === undefined) return false;
    compatibleInputs.push(subtype);
    const key = declared === "anycompatiblerange" ? "compatibleRange" : "compatibleMultirange";
    const current = bindExact(bindings[key], canonical);
    if (current === false) return false;
    bindings[key] = current;
    return true;
  }
  if (declared === "anycompatiblenonarray" && elementType(canonical, schema) !== undefined) return false;
  compatibleInputs.push(canonical);
  return true;
}

function instantiate(declared: string, bindings: TypeBindings): string | undefined {
  if (declared === "anyelement" || declared === "anynonarray" || declared === "anyenum") return bindings.simple;
  if (declared === "anyarray")
    return bindings.simpleArray ?? (bindings.simple === undefined ? undefined : `${bindings.simple}[]`);
  if (declared === "anyrange") return bindings.simpleRange;
  if (declared === "anymultirange") return bindings.simpleMultirange;
  if (declared === "anycompatible" || declared === "anycompatiblenonarray") return bindings.compatible;
  if (declared === "anycompatiblearray")
    return bindings.compatible === undefined ? bindings.compatibleArray : `${bindings.compatible}[]`;
  if (declared === "anycompatiblerange") return bindings.compatibleRange;
  if (declared === "anycompatiblemultirange") return bindings.compatibleMultirange;
  return declared;
}

function rankCandidate<Value>(
  candidate: PostgresCandidate<Value>,
  actualTypes: readonly (string | undefined)[],
  schema?: SchemaSnapshot,
): RankedCandidate<Value> | undefined {
  if (candidate.argumentTypes.length !== actualTypes.length) return undefined;
  const bindings: TypeBindings = {};
  const compatibleInputs: string[] = [];
  let exact = 0;
  let preferred = 0;
  let unknownString = 0;
  for (const [index, declaredValue] of candidate.argumentTypes.entries()) {
    const declared = postgresCanonicalType(declaredValue, schema);
    const actualValue = actualTypes[index];
    const actual = actualValue === undefined ? undefined : postgresCanonicalType(actualValue, schema);
    if (simplePolymorphicTypes.has(declared) || compatiblePolymorphicTypes.has(declared)) {
      if (!bindPolymorphic(declared, actual, bindings, compatibleInputs, schema)) return undefined;
      continue;
    }
    if (actual === undefined) {
      if (category(declared, schema) === "string") unknownString += 1;
      if (isPreferred(declared, schema)) preferred += 1;
      continue;
    }
    if (baseType(actual, schema) === baseType(declared, schema)) exact += 1;
    else if (!postgresCanCoerce(actual, declared, "implicit", schema)) return undefined;
    else if (isPreferred(declared, schema)) preferred += 1;
  }
  if (
    compatibleInputs.length > 0 ||
    candidate.argumentTypes.some((type) => compatiblePolymorphicTypes.has(normalize(type)))
  ) {
    const common = postgresCommonType(compatibleInputs.length === 0 ? [undefined] : compatibleInputs, schema);
    if (common === undefined) return undefined;
    bindings.compatible = common;
  }
  const argumentTypes = candidate.argumentTypes.map((declared) => instantiate(declared, bindings) ?? declared);
  const resultType = instantiate(candidate.resultType, bindings);
  if (resultType === undefined) return undefined;
  return { kind: "selected", candidate: candidate.value, argumentTypes, resultType, exact, preferred, unknownString };
}

/** Selects a PostgreSQL overload using exact, implicit-cast, preferred-type, and unknown-category evidence. */
export function resolvePostgresCandidates<Value>(
  candidates: readonly PostgresCandidate<Value>[],
  actualTypes: readonly (string | undefined)[],
  schema?: SchemaSnapshot,
): PostgresCandidateResolution<Value> {
  let matches = candidates
    .map((candidate) => rankCandidate(candidate, actualTypes, schema))
    .filter((candidate): candidate is RankedCandidate<Value> => candidate !== undefined);
  if (matches.length === 0) return { kind: "none" };
  for (const score of ["exact", "preferred", "unknownString"] as const) {
    const maximum = Math.max(...matches.map((candidate) => candidate[score]));
    if (maximum > 0) matches = matches.filter((candidate) => candidate[score] === maximum);
    if (matches.length === 1) return matches[0]!;
  }
  const known = actualTypes
    .filter((value): value is string => value !== undefined)
    .map((value) => baseType(value, schema));
  if (known.length > 0 && known.every((value) => value === known[0])) {
    const sameType = matches.filter((candidate) =>
      candidate.argumentTypes.every((declared, index) => actualTypes[index] !== undefined || declared === known[0]),
    );
    if (sameType.length === 1) return sameType[0]!;
  }
  return { kind: "ambiguous" };
}

function categoryPairs(
  categoryName: PostgresTypeCategory,
  schema?: SchemaSnapshot,
): readonly [string, string, string][] {
  const types = postgresCoreCatalogForSchema(schema)
    .types.filter(({ category: candidateCategory }) => candidateCategory === categoryName)
    .map(({ name }) => name);
  return types.flatMap((left) =>
    types.flatMap((right): readonly [string, string, string][] => {
      const result = postgresCommonType([left, right], schema);
      return result === undefined ? [] : [[left, right, result]];
    }),
  );
}

function operatorCandidates(operator: string, schema?: SchemaSnapshot): readonly PostgresCandidate<string>[] {
  const rule = postgresCatalogOperatorRule(operator, schema);
  if (rule === "numeric") {
    return categoryPairs("numeric", schema).map(([left, right, result]) => ({
      value: operator,
      argumentTypes: [left, right],
      resultType: result,
    }));
  }
  if (rule === "concatenation") {
    return [
      { value: operator, argumentTypes: ["text", "text"], resultType: "text" },
      {
        value: operator,
        argumentTypes: ["anycompatiblearray", "anycompatiblearray"],
        resultType: "anycompatiblearray",
      },
      { value: operator, argumentTypes: ["anycompatible", "anycompatiblearray"], resultType: "anycompatiblearray" },
      { value: operator, argumentTypes: ["anycompatiblearray", "anycompatible"], resultType: "anycompatiblearray" },
    ];
  }
  if (rule === "json" || rule === "json-text") {
    const result = rule === "json-text" ? "text" : undefined;
    const path = operator.startsWith("#") ? "text[]" : undefined;
    return ["json", "jsonb"].flatMap((left) =>
      (path === undefined ? ["integer", "text"] : [path]).map((right) => ({
        value: operator,
        argumentTypes: [left, right],
        resultType: result ?? left,
      })),
    );
  }
  if (rule !== "boolean") return [];
  if (operator === "AND" || operator === "OR") {
    return [{ value: operator, argumentTypes: ["boolean", "boolean"], resultType: "boolean" }];
  }
  if (patternOperators.has(operator)) {
    return [{ value: operator, argumentTypes: ["text", "text"], resultType: "boolean" }];
  }
  if (operator === "?" || operator === "?&" || operator === "?|") {
    return [
      {
        value: operator,
        argumentTypes: ["jsonb", operator === "?" ? "text" : "text[]"],
        resultType: "boolean",
      },
    ];
  }
  if (operator === "@>" || operator === "<@" || operator === "&&") {
    return [
      { value: operator, argumentTypes: ["anyarray", "anyarray"], resultType: "boolean" },
      ...(operator === "&&" ? [] : [{ value: operator, argumentTypes: ["jsonb", "jsonb"], resultType: "boolean" }]),
    ];
  }
  if (!comparisonOperators.has(operator)) return [];
  const categoryCandidates = (["numeric", "string", "datetime"] as const).flatMap((categoryName) =>
    categoryPairs(categoryName, schema).map(([left, right]) => ({
      value: operator,
      argumentTypes: [left, right],
      resultType: "boolean",
    })),
  );
  return [
    ...categoryCandidates,
    { value: operator, argumentTypes: ["boolean", "boolean"], resultType: "boolean" },
    { value: operator, argumentTypes: ["uuid", "uuid"], resultType: "boolean" },
    { value: operator, argumentTypes: ["bytea", "bytea"], resultType: "boolean" },
    { value: operator, argumentTypes: ["jsonb", "jsonb"], resultType: "boolean" },
    { value: operator, argumentTypes: ["anyenum", "anyenum"], resultType: "boolean" },
    { value: operator, argumentTypes: ["anyarray", "anyarray"], resultType: "boolean" },
  ];
}

/** Resolves built-in binary operators through the same candidate machinery as routine calls. */
export function resolvePostgresOperator(
  operator: string,
  left: string | undefined,
  right: string | undefined,
  schema?: SchemaSnapshot,
): PostgresOperatorResolution {
  const normalizedOperator = operator.toUpperCase();
  const candidates = operatorCandidates(normalizedOperator, schema);
  let inputs: readonly (string | undefined)[] = [left, right];
  if (left === undefined && right !== undefined) inputs = [right, right];
  else if (right === undefined && left !== undefined) inputs = [left, left];
  const assumedExact = resolvePostgresCandidates(candidates, inputs, schema);
  if (assumedExact.kind === "selected" || (left !== undefined && right !== undefined)) return assumedExact;
  return resolvePostgresCandidates(candidates, [left, right], schema);
}
