import { parseSchemaSnapshot, type SchemaSnapshot } from "@typed-sql/schema";
import { assertPostgresServerEvidence } from "./capabilities.js";
import { POSTGRES_DIALECT_VERSION } from "./version.js";
export type PostgresProfileSnapshot = SchemaSnapshot & { readonly dialect: "postgres" };

export function validatePostgresSnapshot(value: unknown): PostgresProfileSnapshot {
  const snapshot = parseSchemaSnapshot(value);
  if (snapshot.dialect !== "postgres") {
    throw new TypeError(`@typed-sql/postgres cannot use a ${snapshot.dialect} schema snapshot`);
  }
  if (snapshot.dialectVersion !== undefined && snapshot.dialectVersion !== POSTGRES_DIALECT_VERSION) {
    throw new TypeError(
      `@typed-sql/postgres grammar ${POSTGRES_DIALECT_VERSION} cannot use snapshot dialectVersion ${snapshot.dialectVersion}`,
    );
  }
  if (snapshot.server !== undefined && snapshot.server.product !== "postgres") {
    throw new TypeError(`@typed-sql/postgres cannot use ${snapshot.server.product} server evidence`);
  }
  if (snapshot.server !== undefined) assertPostgresServerEvidence(snapshot.server);
  return snapshot as PostgresProfileSnapshot;
}
