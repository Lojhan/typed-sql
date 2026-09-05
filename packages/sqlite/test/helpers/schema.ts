import type { SqliteSchemaSnapshot } from "../../src/index.js";

/** Fresh base table: scenario-specific columns remain explicit at each call site. */
export function accountTable() {
  return {
    schema: "main",
    name: "account",
    kind: "table",
    strict: true,
    withoutRowid: false,
    indexes: [],
    foreignKeys: [],
    columns: {
      id: { name: "id", databaseType: "INTEGER", tsType: "bigint", nullable: false },
      email: { name: "email", databaseType: "TEXT", tsType: "string", nullable: false },
      score: { name: "score", databaseType: "REAL", tsType: "number", nullable: true },
    },
  } as const satisfies SqliteSchemaSnapshot["tables"][string];
}

export function serverEvidence(version = "3.53.0") {
  return {
    version,
    server: { product: "sqlite", version, versionKey: version, features: [], settings: {} },
  } as const;
}
