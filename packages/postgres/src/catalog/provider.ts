import type { SchemaSnapshot } from "@typed-sql/schema";
import { parsePostgresMajor } from "../support.js";
import type {
  PostgresCastContext,
  PostgresCatalogCast,
  PostgresCatalogType,
  PostgresCatalogTypeMapping,
  PostgresCoreCatalog,
  PostgresOperatorResultRule,
  PostgresRoutineResultRule,
  PostgresTableRoutineResultRule,
} from "./types.js";

function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

interface CatalogIndex {
  readonly types: ReadonlyMap<string, PostgresCatalogTypeMapping>;
  readonly typeDefinitions: ReadonlyMap<string, PostgresCatalogType>;
  readonly casts: ReadonlyMap<string, PostgresCatalogCast>;
  readonly operators: ReadonlyMap<string, PostgresOperatorResultRule>;
  readonly routines: ReadonlyMap<string, PostgresRoutineResultRule>;
  readonly tableRoutines: ReadonlyMap<string, PostgresTableRoutineResultRule>;
}

const indexes = new WeakMap<PostgresCoreCatalog, CatalogIndex>();

function index(catalog: PostgresCoreCatalog): CatalogIndex {
  const cached = indexes.get(catalog);
  if (cached !== undefined) return cached;
  const created = {
    types: new Map(
      catalog.types.flatMap((type) => [type.name, ...type.aliases].map((name) => [name, type.mapping] as const)),
    ),
    typeDefinitions: new Map(
      catalog.types.flatMap((type) => [type.name, ...type.aliases].map((name) => [name, type] as const)),
    ),
    casts: new Map(catalog.casts.map((cast) => [`${cast.source}>${cast.target}`, cast])),
    operators: new Map(
      catalog.operators.flatMap((family) => family.operators.map((operator) => [operator, family.result] as const)),
    ),
    routines: new Map(
      catalog.routines.flatMap((family) => family.routines.map((routine) => [routine, family.result] as const)),
    ),
    tableRoutines: new Map(
      catalog.tableRoutines.flatMap((family) => family.routines.map((routine) => [routine, family.result] as const)),
    ),
  };
  indexes.set(catalog, created);
  return created;
}

function normalizeType(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\[\]$/u, "")
    .replace(/\(\d+(?:,\s*\d+)?\)/gu, "")
    .replace(/\s+/gu, " ");
  return /^interval(?:\s|$)/u.test(normalized) ? "interval" : normalized;
}

export interface PostgresCatalogProvider {
  catalog(major: number): PostgresCoreCatalog | undefined;
  forSchema(schema?: SchemaSnapshot): PostgresCoreCatalog;
  typeMapping(value: string, schema?: SchemaSnapshot): PostgresCatalogTypeMapping | undefined;
  type(value: string, schema?: SchemaSnapshot): PostgresCatalogType | undefined;
  cast(source: string, target: string, schema?: SchemaSnapshot): PostgresCatalogCast | undefined;
  canCast(source: string, target: string, context: PostgresCastContext, schema?: SchemaSnapshot): boolean;
  operatorRule(value: string, schema?: SchemaSnapshot): PostgresOperatorResultRule | undefined;
  routineRule(value: string, schema?: SchemaSnapshot): PostgresRoutineResultRule | undefined;
  tableRoutineRule(value: string, schema?: SchemaSnapshot): PostgresTableRoutineResultRule | undefined;
}

/** Owns immutable catalog facts. The explicit fallback preserves legacy helper behavior;
 * selected-version callers must validate snapshot evidence before resolution. */
export function createPostgresCatalogProvider(
  input: readonly PostgresCoreCatalog[],
  fallbackMajor: number,
): PostgresCatalogProvider {
  const catalogs = new Map<number, PostgresCoreCatalog>();
  for (const catalog of input) {
    if (catalogs.has(catalog.major)) throw new TypeError(`Duplicate PostgreSQL catalog ${catalog.major}`);
    catalogs.set(catalog.major, deepFreeze(structuredClone(catalog)));
  }
  const fallbackValue = catalogs.get(fallbackMajor);
  if (fallbackValue === undefined) throw new TypeError(`Missing PostgreSQL fallback catalog ${fallbackMajor}`);
  const fallback: PostgresCoreCatalog = fallbackValue;
  function postgresCoreCatalog(major: number): PostgresCoreCatalog | undefined {
    return catalogs.get(major);
  }

  function postgresCoreCatalogForSchema(schema?: SchemaSnapshot): PostgresCoreCatalog {
    const evidence = schema?.server?.versionKey ?? schema?.version;
    const major = evidence === undefined ? undefined : parsePostgresMajor(evidence);
    return (major === undefined ? undefined : postgresCoreCatalog(major)) ?? fallback;
  }

  function postgresCatalogTypeMapping(
    databaseType: string,
    schema?: SchemaSnapshot,
  ): PostgresCatalogTypeMapping | undefined {
    return index(postgresCoreCatalogForSchema(schema)).types.get(normalizeType(databaseType));
  }

  function postgresCatalogType(databaseType: string, schema?: SchemaSnapshot): PostgresCatalogType | undefined {
    return index(postgresCoreCatalogForSchema(schema)).typeDefinitions.get(normalizeType(databaseType));
  }

  function postgresCatalogCast(
    source: string,
    target: string,
    schema?: SchemaSnapshot,
  ): PostgresCatalogCast | undefined {
    const catalogIndex = index(postgresCoreCatalogForSchema(schema));
    const sourceType = catalogIndex.typeDefinitions.get(normalizeType(source))?.name ?? normalizeType(source);
    const targetType = catalogIndex.typeDefinitions.get(normalizeType(target))?.name ?? normalizeType(target);
    return catalogIndex.casts.get(`${sourceType}>${targetType}`);
  }

  function postgresCatalogCanCast(
    source: string,
    target: string,
    context: PostgresCastContext,
    schema?: SchemaSnapshot,
  ): boolean {
    const sourceType = postgresCatalogType(source, schema)?.name ?? normalizeType(source);
    const targetType = postgresCatalogType(target, schema)?.name ?? normalizeType(target);
    if (sourceType === targetType) return true;
    const cast = postgresCatalogCast(sourceType, targetType, schema);
    if (cast === undefined) return false;
    return (
      context === "explicit" ||
      cast.context === "implicit" ||
      (context === "assignment" && cast.context === "assignment")
    );
  }

  function postgresCatalogOperatorRule(
    operator: string,
    schema?: SchemaSnapshot,
  ): PostgresOperatorResultRule | undefined {
    return index(postgresCoreCatalogForSchema(schema)).operators.get(operator.toUpperCase());
  }

  function postgresCatalogRoutineRule(routine: string, schema?: SchemaSnapshot): PostgresRoutineResultRule | undefined {
    return index(postgresCoreCatalogForSchema(schema)).routines.get(routine.toUpperCase());
  }

  function postgresCatalogTableRoutineRule(
    routine: string,
    schema?: SchemaSnapshot,
  ): PostgresTableRoutineResultRule | undefined {
    return index(postgresCoreCatalogForSchema(schema)).tableRoutines.get(routine.toUpperCase());
  }
  return Object.freeze({
    catalog: postgresCoreCatalog,
    forSchema: postgresCoreCatalogForSchema,
    typeMapping: postgresCatalogTypeMapping,
    type: postgresCatalogType,
    cast: postgresCatalogCast,
    canCast: postgresCatalogCanCast,
    operatorRule: postgresCatalogOperatorRule,
    routineRule: postgresCatalogRoutineRule,
    tableRoutineRule: postgresCatalogTableRoutineRule,
  });
}
