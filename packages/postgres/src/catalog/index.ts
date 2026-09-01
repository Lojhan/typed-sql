import type { SchemaSnapshot } from "@typed-sql/schema";
import { POSTGRES_SUPPORT_POLICY, parsePostgresMajor } from "../support.js";
import catalog14 from "./generated/14.js";
import catalog15 from "./generated/15.js";
import catalog16 from "./generated/16.js";
import catalog17 from "./generated/17.js";
import catalog18 from "./generated/18.js";
import catalog19 from "./generated/19.js";
import type {
  PostgresCatalogTypeMapping,
  PostgresCoreCatalog,
  PostgresOperatorResultRule,
  PostgresRoutineResultRule,
  PostgresTableRoutineResultRule,
} from "./types.js";

export type {
  PostgresCatalogOperatorFamily,
  PostgresCatalogRoutineFamily,
  PostgresCatalogTableRoutineFamily,
  PostgresCatalogType,
  PostgresCatalogTypeMapping,
  PostgresCoreCatalog,
  PostgresOperatorResultRule,
  PostgresRoutineResultRule,
  PostgresTableRoutineResultRule,
} from "./types.js";

export const POSTGRES_CORE_CATALOG_FORMAT_VERSION = 1 as const;

function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

const catalogs = new Map<number, PostgresCoreCatalog>(
  [catalog14, catalog15, catalog16, catalog17, catalog18, catalog19].map((catalog) => [
    catalog.major,
    deepFreeze(catalog),
  ]),
);

interface CatalogIndex {
  readonly types: ReadonlyMap<string, PostgresCatalogTypeMapping>;
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
  return value
    .trim()
    .toLowerCase()
    .replace(/\[\]$/u, "")
    .replace(/\(\d+(?:,\s*\d+)?\)/gu, "")
    .replace(/\s+/gu, " ");
}

export function postgresCoreCatalog(major: number): PostgresCoreCatalog | undefined {
  return catalogs.get(major);
}

export function postgresCoreCatalogForSchema(schema?: SchemaSnapshot): PostgresCoreCatalog {
  const evidence = schema?.server?.versionKey ?? schema?.version;
  const major = evidence === undefined ? undefined : parsePostgresMajor(evidence);
  return (
    (major === undefined ? undefined : postgresCoreCatalog(major)) ??
    postgresCoreCatalog(POSTGRES_SUPPORT_POLICY.stableMajors[0])!
  );
}

export function postgresCatalogTypeMapping(
  databaseType: string,
  schema?: SchemaSnapshot,
): PostgresCatalogTypeMapping | undefined {
  return index(postgresCoreCatalogForSchema(schema)).types.get(normalizeType(databaseType));
}

export function postgresCatalogOperatorRule(
  operator: string,
  schema?: SchemaSnapshot,
): PostgresOperatorResultRule | undefined {
  return index(postgresCoreCatalogForSchema(schema)).operators.get(operator.toUpperCase());
}

export function postgresCatalogRoutineRule(
  routine: string,
  schema?: SchemaSnapshot,
): PostgresRoutineResultRule | undefined {
  return index(postgresCoreCatalogForSchema(schema)).routines.get(routine.toUpperCase());
}

export function postgresCatalogTableRoutineRule(
  routine: string,
  schema?: SchemaSnapshot,
): PostgresTableRoutineResultRule | undefined {
  return index(postgresCoreCatalogForSchema(schema)).tableRoutines.get(routine.toUpperCase());
}
