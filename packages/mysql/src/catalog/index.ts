import type { SchemaSnapshot } from "@typed-sql/schema";
import { parseMySqlVersion } from "../support.js";
import catalog84 from "./generated/8.4.js";
import catalog97 from "./generated/9.7.js";
import catalog267 from "./generated/26.7.js";
import type {
  MySqlCatalogCoercion,
  MySqlCatalogCollation,
  MySqlCatalogOperatorFamily,
  MySqlCatalogRoutineFamily,
  MySqlCatalogType,
  MySqlCoercionContext,
  MySqlCoreCatalog,
} from "./types.js";

export type {
  MySqlCatalogCoercion,
  MySqlCatalogCollation,
  MySqlCatalogOperatorFamily,
  MySqlCatalogRoutineFamily,
  MySqlCatalogType,
  MySqlCatalogTypeMapping,
  MySqlCoercionContext,
  MySqlCoercionSafety,
  MySqlCoreCatalog,
  MySqlOperatorResultRule,
  MySqlRoutineResultRule,
  MySqlTypeCategory,
} from "./types.js";

export const MYSQL_CORE_CATALOG_FORMAT_VERSION = 1 as const;

function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const catalogs = new Map<string, MySqlCoreCatalog>(
  [catalog84, catalog97, catalog267].map((catalog) => [catalog.series, deepFreeze(catalog)]),
);

interface CatalogIndex {
  readonly types: ReadonlyMap<string, MySqlCatalogType>;
  readonly coercions: ReadonlyMap<string, MySqlCatalogCoercion>;
  readonly operators: ReadonlyMap<string, MySqlCatalogOperatorFamily>;
  readonly routines: ReadonlyMap<string, MySqlCatalogRoutineFamily>;
  readonly collations: ReadonlyMap<string, MySqlCatalogCollation>;
}

const indexes = new WeakMap<MySqlCoreCatalog, CatalogIndex>();

function withoutTypeParameters(value: string): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const opening = value.indexOf("(", offset);
    if (opening < 0) {
      parts.push(value.slice(offset));
      break;
    }
    const closing = value.indexOf(")", opening + 1);
    if (closing < 0) {
      parts.push(value.slice(offset));
      break;
    }
    parts.push(value.slice(offset, opening));
    offset = closing + 1;
  }
  return parts.join("");
}

function collapseWhitespace(value: string): string {
  const characters: string[] = [];
  let pendingSpace = false;
  for (const character of value) {
    if (character.trim().length === 0) {
      pendingSpace = characters.length > 0;
      continue;
    }
    if (pendingSpace) characters.push(" ");
    characters.push(character);
    pendingSpace = false;
  }
  return characters.join("");
}

function index(catalog: MySqlCoreCatalog): CatalogIndex {
  const cached = indexes.get(catalog);
  if (cached !== undefined) return cached;
  const created = {
    types: new Map(
      catalog.types.flatMap((type) => [type.name, ...type.aliases].map((alias) => [alias, type] as const)),
    ),
    coercions: new Map(catalog.coercions.map((coercion) => [`${coercion.source}>${coercion.target}`, coercion])),
    operators: new Map(
      catalog.operators.flatMap((family) => family.operators.map((operator) => [operator, family] as const)),
    ),
    routines: new Map(
      catalog.routines.flatMap((family) => family.routines.map((routine) => [routine, family] as const)),
    ),
    collations: new Map(catalog.collations.map((collation) => [collation.name, collation])),
  };
  indexes.set(catalog, created);
  return created;
}

export function normalizeMySqlType(value: string): string {
  let normalized = collapseWhitespace(withoutTypeParameters(value.toLowerCase()));
  for (const modifier of ["signed", "unsigned", "zerofill"]) {
    if (normalized.endsWith(` ${modifier}`)) {
      normalized = normalized.slice(0, -(modifier.length + 1));
      break;
    }
  }
  return normalized === "double precision" ? "double" : normalized;
}

function seriesForSchema(schema: SchemaSnapshot | undefined): string | undefined {
  const evidence = schema?.server?.versionKey ?? schema?.version;
  const version = evidence === undefined ? undefined : parseMySqlVersion(evidence);
  return version === undefined ? undefined : `${version[0]}.${version[1]}`;
}

export function mySqlCoreCatalog(series: string): MySqlCoreCatalog | undefined {
  return catalogs.get(series);
}

export function mySqlCoreCatalogForSchema(schema: SchemaSnapshot | undefined): MySqlCoreCatalog | undefined {
  const series = seriesForSchema(schema);
  return series === undefined ? undefined : mySqlCoreCatalog(series);
}

function selected(schema?: SchemaSnapshot): MySqlCoreCatalog | undefined {
  const evidence = schema?.server?.versionKey ?? schema?.version;
  if (evidence === undefined) return catalog84;
  return mySqlCoreCatalogForSchema(schema);
}

export function mySqlCatalogType(databaseType: string, schema?: SchemaSnapshot): MySqlCatalogType | undefined {
  const catalog = selected(schema);
  return catalog === undefined ? undefined : index(catalog).types.get(normalizeMySqlType(databaseType));
}

export function mySqlCatalogCoercion(
  source: string,
  target: string,
  schema?: SchemaSnapshot,
): MySqlCatalogCoercion | undefined {
  const catalog = selected(schema);
  if (catalog === undefined) return undefined;
  const catalogIndex = index(catalog);
  const sourceType = catalogIndex.types.get(normalizeMySqlType(source))?.name ?? normalizeMySqlType(source);
  const targetType = catalogIndex.types.get(normalizeMySqlType(target))?.name ?? normalizeMySqlType(target);
  return catalogIndex.coercions.get(`${sourceType}>${targetType}`);
}

export function mySqlCatalogCanCoerce(
  source: string,
  target: string,
  context: MySqlCoercionContext,
  schema?: SchemaSnapshot,
): boolean {
  const sourceType = mySqlCatalogType(source, schema)?.name ?? normalizeMySqlType(source);
  const targetType = mySqlCatalogType(target, schema)?.name ?? normalizeMySqlType(target);
  if (sourceType === targetType) return true;
  return mySqlCatalogCoercion(sourceType, targetType, schema)?.contexts.includes(context) ?? false;
}

export function mySqlCatalogOperator(
  operator: string,
  schema?: SchemaSnapshot,
): MySqlCatalogOperatorFamily | undefined {
  const catalog = selected(schema);
  return catalog === undefined ? undefined : index(catalog).operators.get(operator.toUpperCase());
}

export function mySqlCatalogRoutine(routine: string, schema?: SchemaSnapshot): MySqlCatalogRoutineFamily | undefined {
  const catalog = selected(schema);
  return catalog === undefined ? undefined : index(catalog).routines.get(routine.toUpperCase());
}

export function mySqlCatalogCollation(collation: string, schema?: SchemaSnapshot): MySqlCatalogCollation | undefined {
  const catalog = selected(schema);
  return catalog === undefined ? undefined : index(catalog).collations.get(collation.toLowerCase());
}

export function mySqlCatalogHasRoutineInAnotherSeries(routine: string, schema?: SchemaSnapshot): boolean {
  const current = mySqlCoreCatalogForSchema(schema);
  const normalized = routine.toUpperCase();
  return [...catalogs.values()].some((catalog) => catalog !== current && index(catalog).routines.has(normalized));
}
