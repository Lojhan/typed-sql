import type { RoutineSnapshot, SchemaSnapshot } from "@typed-sql/schema";
import { postgresCatalogType } from "./catalog/index.js";
import { mapPostgresType, type PostgresTypePolicy } from "./type-policy.js";

export const postgresProjectCatalogOwner = Object.freeze({
  id: "@typed-sql/postgres/project-catalog",
  version: "postgres-project-catalog-v1",
});
export const postgresProjectCatalogPermissionKey = "projectRoutineInference";
/** Only fixed scalar identities with known policy/codec mappings receive reusable permission. */
export function postgresProjectRoutineIsFixed(
  routine: RoutineSnapshot,
  schema: SchemaSnapshot,
  policy: PostgresTypePolicy,
): boolean {
  const known = (type: { readonly databaseType: string; readonly typeIdentity: string }): boolean => {
    if (!type.typeIdentity.startsWith("pg_catalog.") || /[.()[\]]/u.test(type.databaseType)) return false;
    const catalog = postgresCatalogType(type.databaseType, schema);
    return (
      catalog !== undefined &&
      postgresCatalogType(type.typeIdentity.slice("pg_catalog.".length), schema)?.name === catalog.name &&
      catalog.mapping !== "numeric" &&
      mapPostgresType(type.databaseType, policy, schema) !== "unknown"
    );
  };
  return (
    routine.kind === "function" &&
    routine.result.kind === "scalar" &&
    routine.polymorphicFamily === undefined &&
    routine.availableSince === undefined &&
    routine.availableUntil === undefined &&
    known(routine.result) &&
    routine.arguments.every((argument) => argument.mode === "in" && argument.default === "none" && known(argument))
  );
}
const families = new WeakMap<SchemaSnapshot, ReadonlyMap<string, readonly RoutineSnapshot[]>>();
export function postgresProjectRoutineFamily(
  schema: SchemaSnapshot,
  name: string,
  namespace?: string,
): readonly RoutineSnapshot[] {
  if (schema.formatVersion !== 2) return [];
  let indexed = families.get(schema);
  if (!indexed) {
    const byName = new Map<string, RoutineSnapshot[]>();
    for (const routine of Object.values(schema.routines).flat()) {
      if (routine.extension?.attributes[postgresProjectCatalogPermissionKey] === undefined) continue;
      const existing = byName.get(routine.name) ?? [];
      existing.push(routine);
      byName.set(routine.name, existing);
    }
    indexed = byName;
    families.set(schema, indexed);
  }
  return (indexed.get(name) ?? []).filter((routine) => namespace === undefined || routine.schema === namespace);
}
