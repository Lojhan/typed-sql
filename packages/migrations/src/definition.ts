import { renderQuery, type SqlRenderer } from "@typed-sql/core";
import { digest, jsonValue, MigrationError, object, validateCapturedChecks } from "./codec.js";
import type {
  CapturedChecks,
  CapturedMigration,
  MigrationCheck,
  MigrationDefinition,
  MigrationSql,
  MigrationStatement,
  MigrationsConfig,
} from "./types.js";

export function defineMigration<const T extends MigrationDefinition>(definition: T): T {
  return definition;
}
export function defineMigrations<const T extends MigrationsConfig>(config: T): T {
  return config;
}
export const checks = Object.freeze({
  applicationSnapshotCurrent: (
    options: Omit<MigrationCheck, "kind"> & { readonly schemaHash: string },
  ): MigrationCheck => ({ ...options, kind: "applicationSnapshotCurrent" }),
  noRows: (options: Omit<MigrationCheck, "kind"> & { readonly query: MigrationSql }): MigrationCheck => ({
    ...options,
    kind: "noRows",
  }),
  assertBoolean: (options: Omit<MigrationCheck, "kind"> & { readonly query: MigrationSql }): MigrationCheck => ({
    ...options,
    kind: "boolean",
  }),
  schemaMatches: (
    options: Omit<MigrationCheck, "kind"> & { readonly expected: NonNullable<MigrationCheck["expected"]> },
  ): MigrationCheck => ({ ...options, kind: "schemaMatches" }),
  objectExists: (options: Omit<MigrationCheck, "kind"> & { readonly object: string }): MigrationCheck => ({
    ...options,
    kind: "objectExists",
  }),
  objectAbsent: (options: Omit<MigrationCheck, "kind"> & { readonly object: string }): MigrationCheck => ({
    ...options,
    kind: "objectAbsent",
  }),
});
export function captureStatement(value: MigrationSql, renderer: SqlRenderer): MigrationStatement {
  if (typeof value === "string") return { text: value, values: [] };
  const record = object(value, "Migration SQL");
  if ("segments" in record) {
    const rendered = renderQuery(value as Parameters<typeof renderQuery>[0], renderer);
    return { text: rendered.text, values: rendered.values.map(jsonValue) };
  }
  if (typeof record.text === "string" && Array.isArray(record.values))
    return { text: record.text, values: record.values.map(jsonValue) };
  throw new MigrationError("MIGRATION_SQL", "Expected SQL text, a grammar sql template, or a captured statement.");
}
export function captureChecks(input: MigrationDefinition["checks"], renderer: SqlRenderer): CapturedChecks {
  const output: Record<string, unknown> = {};
  for (const [phase, values] of Object.entries(input ?? {})) {
    if (
      !["beforeBatch", "beforeUp", "afterUp", "beforeDown", "afterDown", "afterBatch"].includes(phase) ||
      !Array.isArray(values)
    )
      throw new MigrationError("MIGRATION_CHECK", "Invalid migration check phase.");
    const ids = new Set<string>();
    output[phase] = values.map((check: MigrationCheck) => {
      if (!check || typeof check.id !== "string" || !check.id || ids.has(check.id))
        throw new MigrationError("MIGRATION_CHECK", "Checks require unique stable IDs within each phase.");
      ids.add(check.id);
      if (
        !["noRows", "boolean", "schemaMatches", "objectExists", "objectAbsent", "applicationSnapshotCurrent"].includes(
          check.kind,
        )
      )
        throw new MigrationError("MIGRATION_CHECK", "Unsupported migration check kind.");
      const { query, ...rest } = check;
      return { ...rest, ...(query === undefined ? {} : { query: captureStatement(query, renderer) }) };
    });
  }
  validateCapturedChecks(output);
  return output as CapturedChecks;
}
export function captureMigration(
  definition: MigrationDefinition,
  files: Readonly<Record<string, string>>,
  renderer: SqlRenderer,
): CapturedMigration {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,180}$/u.test(definition.id))
    throw new MigrationError(
      "MIGRATION_ID",
      "Migration IDs must contain only letters, numbers, underscore and hyphen.",
    );
  if (!Array.isArray(definition.up) || definition.up.length === 0)
    throw new MigrationError("MIGRATION_UP", "Each migration requires at least one up operation.");
  if (definition.transaction !== undefined && !["required", "none"].includes(definition.transaction))
    throw new MigrationError("MIGRATION_TRANSACTION", "Unsupported transaction mode.");
  if (
    definition.reconciliation !== undefined &&
    (!definition.reconciliation.reason?.trim() ||
      !Array.isArray(definition.reconciliation.expectedObjects) ||
      !definition.reconciliation.expectedObjects.length ||
      definition.reconciliation.expectedObjects.some((key) => typeof key !== "string" || !key))
  )
    throw new MigrationError(
      "MIGRATION_RECONCILE_INTENT",
      "Reconciliation intent requires a reason and exact qualified catalog keys.",
    );
  const captured = {
    id: definition.id,
    description: definition.description ?? definition.id,
    transaction: definition.transaction ?? "required",
    up: definition.up.map((v) => captureStatement(v, renderer)),
    ...(definition.down === undefined ? {} : { down: definition.down.map((v) => captureStatement(v, renderer)) }),
    ...(definition.irreversibleReason === undefined ? {} : { irreversibleReason: definition.irreversibleReason }),
    checks: captureChecks(definition.checks, renderer),
    ...(definition.reconciliation === undefined ? {} : { reconciliation: definition.reconciliation }),
    files,
  } as const;
  return { ...captured, hash: digest(captured) };
}
