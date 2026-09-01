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
const numericOperatorTypes = new Set(["smallint", "integer", "bigint", "numeric", "real", "double precision"]);

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

/** Returns the element identity for a PostgreSQL array or snapshot collection type. */
export function postgresElementType(databaseType: string, schema?: SchemaSnapshot): string | undefined {
  return elementType(databaseType, schema);
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
  for (const [index, actual] of actualTypes.entries()) {
    if (actual !== undefined) continue;
    const categories = new Set(
      matches
        .map((candidate) => category(candidate.argumentTypes[index]!, schema))
        .filter((candidate): candidate is PostgresTypeCategory => candidate !== undefined),
    );
    const selectedCategory = categories.has("string")
      ? "string"
      : categories.size === 1
        ? [...categories][0]
        : undefined;
    if (selectedCategory === undefined) return { kind: "ambiguous" };
    matches = matches.filter((candidate) => category(candidate.argumentTypes[index]!, schema) === selectedCategory);
    const preferred = matches.filter((candidate) => isPreferred(candidate.argumentTypes[index]!, schema));
    if (preferred.length > 0) matches = preferred;
    if (matches.length === 1) return matches[0]!;
  }
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

function categoryTypes(categoryName: PostgresTypeCategory, schema?: SchemaSnapshot): readonly string[] {
  return postgresCoreCatalogForSchema(schema)
    .types.filter(({ category: candidateCategory }) => candidateCategory === categoryName)
    .map(({ name }) => name);
}

function numericOperatorCandidates(operator: string): readonly PostgresCandidate<string>[] {
  const candidates: PostgresCandidate<string>[] = [];
  const add = (left: string, right: string, resultType: string): void => {
    candidates.push({ value: operator, argumentTypes: [left, right], resultType });
  };
  const integral = ["smallint", "integer", "bigint"] as const;
  const integralResult = (left: (typeof integral)[number], right: (typeof integral)[number]): string =>
    integral[Math.max(integral.indexOf(left), integral.indexOf(right))]!;
  if (["+", "-", "*", "/"].includes(operator)) {
    for (const left of integral) {
      for (const right of integral) add(left, right, integralResult(left, right));
    }
    add("real", "real", "real");
    add("real", "double precision", "double precision");
    add("double precision", "real", "double precision");
    add("double precision", "double precision", "double precision");
    add("numeric", "numeric", "numeric");
  } else if (operator === "%") {
    for (const type of integral) add(type, type, type);
    add("numeric", "numeric", "numeric");
  } else if (operator === "^") {
    add("numeric", "numeric", "numeric");
    add("double precision", "double precision", "double precision");
  }
  return candidates;
}

function temporalOperatorCandidates(operator: string): readonly PostgresCandidate<string>[] {
  const candidates: PostgresCandidate<string>[] = [];
  const add = (left: string, right: string, resultType: string): void => {
    candidates.push({ value: operator, argumentTypes: [left, right], resultType });
  };
  if (operator === "+") {
    add("date", "integer", "date");
    add("integer", "date", "date");
    for (const type of ["timestamp", "timestamptz", "time"] as const) {
      add(type, "interval", type);
      add("interval", type, type);
    }
    add("interval", "interval", "interval");
  } else if (operator === "-") {
    add("date", "integer", "date");
    add("date", "date", "integer");
    for (const type of ["timestamp", "timestamptz", "time"] as const) {
      add(type, type, "interval");
      add(type, "interval", type);
    }
    add("interval", "interval", "interval");
  } else if (operator === "*") {
    for (const numeric of numericOperatorTypes) {
      add("interval", numeric, "interval");
      add(numeric, "interval", "interval");
    }
  } else if (operator === "/") {
    for (const numeric of numericOperatorTypes) add("interval", numeric, "interval");
  }
  return candidates;
}

const builtInRangeFamilies = [
  ["int4range", "int4multirange", "integer"],
  ["int8range", "int8multirange", "bigint"],
  ["numrange", "nummultirange", "numeric"],
  ["tsrange", "tsmultirange", "timestamp"],
  ["tstzrange", "tstzmultirange", "timestamptz"],
  ["daterange", "datemultirange", "date"],
] as const;

function specialOperatorCandidates(operator: string): readonly PostgresCandidate<string>[] {
  const candidates: PostgresCandidate<string>[] = [];
  const add = (left: string, right: string, resultType: string): void => {
    if (
      candidates.some(
        (candidate) =>
          candidate.argumentTypes[0] === left &&
          candidate.argumentTypes[1] === right &&
          candidate.resultType === resultType,
      )
    )
      return;
    candidates.push({ value: operator, argumentTypes: [left, right], resultType });
  };
  for (const [range, multirange, element] of builtInRangeFamilies) {
    if (operator === "@>") {
      for (const [left, right] of [
        [range, range],
        [range, element],
        [range, multirange],
        [multirange, multirange],
        [multirange, range],
        [multirange, element],
      ] as const)
        add(left, right, "boolean");
    } else if (operator === "<@") {
      for (const [left, right] of [
        [range, range],
        [element, range],
        [multirange, multirange],
        [multirange, range],
        [range, multirange],
        [element, multirange],
      ] as const)
        add(left, right, "boolean");
    } else if (["&&", "<<", ">>", "&<", "&>"].includes(operator)) {
      for (const [left, right] of [
        [range, range],
        [multirange, multirange],
        [range, multirange],
        [multirange, range],
      ] as const)
        add(left, right, "boolean");
    } else if (operator === "-\u007c-") {
      for (const [left, right] of [
        [range, range],
        [multirange, multirange],
        [range, multirange],
        [multirange, range],
      ] as const)
        add(left, right, "boolean");
    } else if (["+", "*", "-"].includes(operator)) {
      add(range, range, range);
      add(multirange, multirange, multirange);
    }
  }
  const geometric = ["point", "box", "lseg", "line", "path", "polygon", "circle"] as const;
  const sameGeometric = (types: readonly string[], resultType: string): void => {
    for (const type of types) add(type, type, resultType);
  };
  if (["+", "-", "*", "/"].includes(operator)) {
    for (const type of ["point", "box", "path", "circle"] as const) add(type, "point", type);
    if (operator === "+") add("path", "path", "path");
  } else if (operator === "#") {
    add("lseg", "lseg", "point");
    add("line", "line", "point");
    add("box", "box", "box");
  } else if (operator === "##") {
    for (const [left, right] of [
      ["point", "box"],
      ["point", "lseg"],
      ["point", "line"],
      ["lseg", "box"],
      ["lseg", "lseg"],
      ["line", "lseg"],
    ] as const)
      add(left, right, "point");
  } else if (operator === "<->") {
    sameGeometric(geometric, "double precision");
    for (const type of geometric) {
      add("point", type, "double precision");
      add(type, "point", "double precision");
    }
    for (const [left, right] of [
      ["box", "lseg"],
      ["lseg", "line"],
      ["polygon", "circle"],
    ] as const) {
      add(left, right, "double precision");
      add(right, left, "double precision");
    }
  } else if (operator === "@>") {
    for (const [left, right] of [
      ["box", "point"],
      ["box", "box"],
      ["path", "point"],
      ["polygon", "point"],
      ["polygon", "polygon"],
      ["circle", "point"],
      ["circle", "circle"],
    ] as const)
      add(left, right, "boolean");
  } else if (operator === "<@") {
    for (const [left, right] of [
      ["point", "box"],
      ["point", "lseg"],
      ["point", "line"],
      ["point", "path"],
      ["point", "polygon"],
      ["point", "circle"],
      ["box", "box"],
      ["lseg", "box"],
      ["lseg", "line"],
      ["polygon", "polygon"],
      ["circle", "circle"],
    ] as const)
      add(left, right, "boolean");
  } else if (operator === "&&") sameGeometric(["box", "polygon", "circle"], "boolean");
  else if (operator === "<<" || operator === ">>") sameGeometric(["point", "box", "polygon", "circle"], "boolean");
  else if (["&<", "&>", "&<|", "|&>"].includes(operator)) sameGeometric(["box", "polygon", "circle"], "boolean");
  else if (operator === "<<|" || operator === "|>>") sameGeometric(["point", "box", "polygon", "circle"], "boolean");
  else if (operator === "<^" || operator === ">^") {
    add("box", "box", "boolean");
    add("point", "point", "boolean");
  } else if (operator === "?#") {
    for (const [left, right] of [
      ["box", "box"],
      ["lseg", "box"],
      ["lseg", "lseg"],
      ["lseg", "line"],
      ["line", "box"],
      ["line", "line"],
      ["path", "path"],
    ] as const)
      add(left, right, "boolean");
  } else if (operator === "?-" || operator === "?|") add("point", "point", "boolean");
  else if (operator === "?-|" || operator === "?||") sameGeometric(["line", "lseg"], "boolean");
  else if (operator === "~=") sameGeometric(["point", "box", "polygon", "circle"], "boolean");
  if (operator === "<<" || operator === ">>") {
    for (const type of ["smallint", "integer", "bigint"] as const) add(type, "integer", type);
    add("bit", "integer", "bit");
  }
  if (["<<", "<<=", ">>", ">>=", "&&"].includes(operator)) add("inet", "inet", "boolean");
  if (operator === "&" || operator === "|") {
    add("inet", "inet", "inet");
    add("macaddr", "macaddr", "macaddr");
    add("macaddr8", "macaddr8", "macaddr8");
  }
  if (operator === "+") {
    add("inet", "bigint", "inet");
    add("bigint", "inet", "inet");
    add("money", "money", "money");
    add("pg_lsn", "numeric", "pg_lsn");
    add("numeric", "pg_lsn", "pg_lsn");
  } else if (operator === "-") {
    add("inet", "bigint", "inet");
    add("inet", "inet", "bigint");
    add("jsonb", "text", "jsonb");
    add("jsonb", "text[]", "jsonb");
    add("jsonb", "integer", "jsonb");
    add("money", "money", "money");
    add("pg_lsn", "numeric", "pg_lsn");
    add("pg_lsn", "pg_lsn", "numeric");
  } else if (operator === "*") {
    for (const numeric of ["smallint", "integer", "bigint", "real", "double precision"] as const) {
      add("money", numeric, "money");
      add(numeric, "money", "money");
    }
  } else if (operator === "/") {
    for (const numeric of ["smallint", "integer", "bigint", "real", "double precision"] as const)
      add("money", numeric, "money");
    add("money", "money", "double precision");
  } else if (operator === "#-") add("jsonb", "text[]", "jsonb");
  else if (operator === "@?") add("jsonb", "jsonpath", "boolean");
  else if (operator === "@@") {
    add("jsonb", "jsonpath", "boolean");
    add("tsvector", "tsquery", "boolean");
    add("tsquery", "tsvector", "boolean");
    add("text", "tsquery", "boolean");
  } else if (operator === "&&") add("tsquery", "tsquery", "tsquery");
  else if (operator === "||") {
    add("text", "anynonarray", "text");
    add("anynonarray", "text", "text");
    add("bytea", "bytea", "bytea");
    add("varbit", "varbit", "varbit");
    add("jsonb", "jsonb", "jsonb");
    add("tsvector", "tsvector", "tsvector");
    add("tsquery", "tsquery", "tsquery");
  } else if (operator === "^@") add("text", "text", "boolean");
  if (comparisonOperators.has(operator)) {
    add("tsvector", "tsvector", "boolean");
    add("tsquery", "tsquery", "boolean");
  }
  return candidates;
}

function operatorCandidates(operator: string, schema?: SchemaSnapshot): readonly PostgresCandidate<string>[] {
  const rule = postgresCatalogOperatorRule(operator, schema);
  const special = specialOperatorCandidates(operator);
  if (rule === "numeric") {
    return [...numericOperatorCandidates(operator), ...temporalOperatorCandidates(operator), ...special];
  }
  if (rule === "bitwise") {
    return [
      ...["smallint", "integer", "bigint"].map((type) => ({
        value: operator,
        argumentTypes: [type, type],
        resultType: type,
      })),
      { value: operator, argumentTypes: ["bit", "bit"], resultType: "bit" },
      ...special,
    ];
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
      ...special,
    ];
  }
  if (rule === "json" || rule === "json-text") {
    const result = rule === "json-text" ? "text" : undefined;
    const path = operator.startsWith("#") ? "text[]" : undefined;
    return [
      ...["json", "jsonb"].flatMap((left) =>
        (path === undefined ? ["integer", "text"] : [path]).map((right) => ({
          value: operator,
          argumentTypes: [left, right],
          resultType: result ?? left,
        })),
      ),
      ...special,
    ];
  }
  if (rule === "special") return special;
  if (rule !== "boolean") return special;
  if (operator === "AND" || operator === "OR") {
    return [{ value: operator, argumentTypes: ["boolean", "boolean"], resultType: "boolean" }, ...special];
  }
  if (patternOperators.has(operator)) {
    return [{ value: operator, argumentTypes: ["text", "text"], resultType: "boolean" }, ...special];
  }
  if (operator === "?" || operator === "?&" || operator === "?|") {
    return [
      {
        value: operator,
        argumentTypes: ["jsonb", operator === "?" ? "text" : "text[]"],
        resultType: "boolean",
      },
      ...special,
    ];
  }
  if (operator === "@>" || operator === "<@" || operator === "&&") {
    return [
      { value: operator, argumentTypes: ["anyarray", "anyarray"], resultType: "boolean" },
      ...(operator === "&&" ? [] : [{ value: operator, argumentTypes: ["jsonb", "jsonb"], resultType: "boolean" }]),
      ...special,
    ];
  }
  if (!comparisonOperators.has(operator)) return [];
  const categoryCandidates = (
    ["numeric", "string", "datetime", "timespan", "bit-string", "network", "range"] as const
  ).flatMap((categoryName) =>
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
    { value: operator, argumentTypes: ["pg_lsn", "pg_lsn"], resultType: "boolean" },
    { value: operator, argumentTypes: ["tid", "tid"], resultType: "boolean" },
    { value: operator, argumentTypes: ["anyenum", "anyenum"], resultType: "boolean" },
    { value: operator, argumentTypes: ["anyarray", "anyarray"], resultType: "boolean" },
    ...special,
  ];
}

/** Resolves PostgreSQL prefix operators through grammar-owned operator candidates. */
export function resolvePostgresUnaryOperator(
  operator: string,
  operand: string | undefined,
  schema?: SchemaSnapshot,
): PostgresOperatorResolution {
  const normalizedOperator = operator.toUpperCase();
  const candidates: readonly PostgresCandidate<string>[] =
    normalizedOperator === "NOT"
      ? [{ value: normalizedOperator, argumentTypes: ["boolean"], resultType: "boolean" }]
      : normalizedOperator === "+" || normalizedOperator === "-"
        ? categoryTypes("numeric", schema)
            .filter((type) => numericOperatorTypes.has(type))
            .map((type) => ({
              value: normalizedOperator,
              argumentTypes: [type],
              resultType: type,
            }))
        : normalizedOperator === "~"
          ? ["smallint", "integer", "bigint", "bit", "inet", "macaddr", "macaddr8"].map((type) => ({
              value: normalizedOperator,
              argumentTypes: [type],
              resultType: type,
            }))
          : normalizedOperator === "!!"
            ? [{ value: normalizedOperator, argumentTypes: ["tsquery"], resultType: "tsquery" }]
            : normalizedOperator === "@"
              ? [...numericOperatorTypes].map((type) => ({
                  value: normalizedOperator,
                  argumentTypes: [type],
                  resultType: type,
                }))
              : normalizedOperator === "|/" || normalizedOperator === "||/"
                ? [
                    {
                      value: normalizedOperator,
                      argumentTypes: ["double precision"],
                      resultType: "double precision",
                    },
                  ]
                : normalizedOperator === "@-@"
                  ? ["lseg", "path"].map((type) => ({
                      value: normalizedOperator,
                      argumentTypes: [type],
                      resultType: "double precision",
                    }))
                  : normalizedOperator === "@@"
                    ? ["box", "lseg", "polygon", "circle"].map((type) => ({
                        value: normalizedOperator,
                        argumentTypes: [type],
                        resultType: "point",
                      }))
                    : normalizedOperator === "#"
                      ? ["path", "polygon"].map((type) => ({
                          value: normalizedOperator,
                          argumentTypes: [type],
                          resultType: "integer",
                        }))
                      : normalizedOperator === "?-" || normalizedOperator === "?|"
                        ? ["line", "lseg"].map((type) => ({
                            value: normalizedOperator,
                            argumentTypes: [type],
                            resultType: "boolean",
                          }))
                        : [];
  if (operand === undefined && candidates.length !== 1) {
    return candidates.length === 0 ? { kind: "none" } : { kind: "ambiguous" };
  }
  return resolvePostgresCandidates(candidates, [operand], schema);
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
