import type { DialectServerEvidence } from "@typed-sql/core";
import {
  matchesSchemaHash,
  matchesTypePolicyHash,
  parseSchemaSnapshot,
  type SchemaSnapshotV2,
} from "@typed-sql/schema";
import { assertPostgresServerEvidence } from "./capabilities.js";
import { postgresCoreCatalog } from "./catalog/index.js";
import { parsePostgresMajor } from "./support.js";
import type { PostgresTypePolicy } from "./type-policy.js";
import { POSTGRES_DIALECT_VERSION } from "./version.js";

export type PostgresRuntimeCompatibilityReason =
  | "artifact"
  | "catalog-revision"
  | "extensions"
  | "grammar-version"
  | "search-path"
  | "server-version"
  | "type-policy";

/** Fail-closed mismatch between compile-time evidence and a PostgreSQL execution target. */
export class PostgresRuntimeCompatibilityError extends Error {
  readonly code = "POSTGRES_RUNTIME_INCOMPATIBLE";
  readonly reason: PostgresRuntimeCompatibilityReason;

  constructor(reason: PostgresRuntimeCompatibilityReason, message: string) {
    super(message);
    this.name = "PostgresRuntimeCompatibilityError";
    this.reason = reason;
  }
}

function sortedEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function parsePostgresRuntimeSnapshot(source: unknown): SchemaSnapshotV2 {
  const snapshot = parseSchemaSnapshot(source);
  if (snapshot.dialect !== "postgres" || snapshot.formatVersion !== 2) {
    throw new PostgresRuntimeCompatibilityError(
      "artifact",
      "PostgreSQL runtime compatibility requires a PostgreSQL schema format 2 snapshot",
    );
  }
  return snapshot;
}

/** Compares a generated snapshot with canonical, non-secret evidence from an opened server. */
export function validatePostgresRuntimeCompatibility(
  source: unknown,
  actual: DialectServerEvidence,
  policy?: PostgresTypePolicy,
): void {
  const snapshot = parsePostgresRuntimeSnapshot(source);
  assertPostgresServerEvidence(actual);
  if (snapshot.dialectVersion !== POSTGRES_DIALECT_VERSION) {
    throw new PostgresRuntimeCompatibilityError(
      "grammar-version",
      `PostgreSQL snapshot grammar ${String(snapshot.dialectVersion)} does not match runtime grammar ${POSTGRES_DIALECT_VERSION}`,
    );
  }
  assertPostgresServerEvidence(snapshot.server);
  if (snapshot.server.versionKey !== actual.versionKey) {
    throw new PostgresRuntimeCompatibilityError(
      "server-version",
      `PostgreSQL snapshot major ${snapshot.server.versionKey} does not match server major ${actual.versionKey}`,
    );
  }
  const expectedFeatures = [...snapshot.server.features].sort();
  const actualFeatures = [...actual.features].sort();
  if (!sortedEqual(expectedFeatures, actualFeatures)) {
    throw new PostgresRuntimeCompatibilityError(
      "extensions",
      "PostgreSQL installed extension identities do not match the generated snapshot",
    );
  }
  for (const setting of ["standardConformingStrings", "searchPath"] as const) {
    const expected = snapshot.server.settings[setting];
    if (expected !== undefined && expected !== actual.settings[setting]) {
      throw new PostgresRuntimeCompatibilityError(
        setting === "searchPath" ? "search-path" : "artifact",
        `PostgreSQL ${setting} evidence does not match the generated snapshot`,
      );
    }
  }
  const major = parsePostgresMajor(actual.versionKey);
  const runtimeRevision = major === undefined ? undefined : postgresCoreCatalog(major)?.revision;
  const snapshotRevision = snapshot.extension?.attributes.catalogRevision;
  if (typeof snapshotRevision !== "string" || runtimeRevision === undefined || snapshotRevision !== runtimeRevision) {
    throw new PostgresRuntimeCompatibilityError(
      "catalog-revision",
      "PostgreSQL built-in catalog revision does not match the generated snapshot",
    );
  }
  if (snapshot.metadata !== undefined) {
    if (!matchesSchemaHash(snapshot, snapshot.metadata.schemaHash)) {
      throw new PostgresRuntimeCompatibilityError("artifact", "PostgreSQL snapshot schema identity is corrupt");
    }
    if (!matchesTypePolicyHash(policy ?? {}, snapshot.metadata.typePolicyHash)) {
      throw new PostgresRuntimeCompatibilityError(
        "type-policy",
        "PostgreSQL snapshot type-policy evidence does not match the runtime codec policy",
      );
    }
  }
}
