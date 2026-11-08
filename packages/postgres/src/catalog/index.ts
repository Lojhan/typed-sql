import type { SchemaSnapshot } from "@typed-sql/schema";
import { POSTGRES_SUPPORT_POLICY, parsePostgresMajor } from "../support.js";
import { postgresCatalogs } from "./generated/registry.js";
import * as resolution from "./resolution.js";
import type { PostgresCastContext, PostgresCoreCatalog } from "./types.js";

export { POSTGRES_CORE_CATALOG_FORMAT_VERSION } from "./resolution.js";
export type * from "./types.js";

const catalogs = new Map(postgresCatalogs.map((catalog) => [catalog.major, resolution.freezePostgresCatalog(catalog)]));
export function postgresCoreCatalog(major: number): PostgresCoreCatalog | undefined {
  return catalogs.get(major);
}
export function postgresCoreCatalogForSchema(schema?: SchemaSnapshot): PostgresCoreCatalog {
  const evidence = schema?.server?.versionKey ?? schema?.version;
  const major = evidence === undefined ? undefined : parsePostgresMajor(evidence);
  return (
    (major === undefined ? undefined : catalogs.get(major)) ?? catalogs.get(POSTGRES_SUPPORT_POLICY.stableMajors[0])!
  );
}
const defaultSnapshot = { formatVersion: 1, dialect: "postgres", tables: {} } as const;
const scopedSnapshots = new WeakMap<SchemaSnapshot, SchemaSnapshot>();
export function scopePostgresSchema(schema: SchemaSnapshot = defaultSnapshot): SchemaSnapshot {
  const cached = scopedSnapshots.get(schema);
  if (cached !== undefined) return cached;
  const scoped = resolution.scopePostgresCatalog(schema, postgresCoreCatalogForSchema(schema));
  scopedSnapshots.set(schema, scoped);
  return scoped;
}
export function postgresCatalogTypeMapping(databaseType: string, schema?: SchemaSnapshot) {
  return resolution.postgresCatalogTypeMapping(databaseType, scopePostgresSchema(schema));
}
export function postgresCatalogType(databaseType: string, schema?: SchemaSnapshot) {
  return resolution.postgresCatalogType(databaseType, scopePostgresSchema(schema));
}
export function postgresCatalogCast(source: string, target: string, schema?: SchemaSnapshot) {
  return resolution.postgresCatalogCast(source, target, scopePostgresSchema(schema));
}
export function postgresCatalogCanCast(
  source: string,
  target: string,
  context: PostgresCastContext,
  schema?: SchemaSnapshot,
) {
  return resolution.postgresCatalogCanCast(source, target, context, scopePostgresSchema(schema));
}
export function postgresCatalogOperatorRule(operator: string, schema?: SchemaSnapshot) {
  return resolution.postgresCatalogOperatorRule(operator, scopePostgresSchema(schema));
}
export function postgresCatalogRoutineRule(routine: string, schema?: SchemaSnapshot) {
  return resolution.postgresCatalogRoutineRule(routine, scopePostgresSchema(schema));
}
export function postgresCatalogTableRoutineRule(routine: string, schema?: SchemaSnapshot) {
  return resolution.postgresCatalogTableRoutineRule(routine, scopePostgresSchema(schema));
}
