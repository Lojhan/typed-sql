import { parseSchemaSnapshot, type SchemaSnapshotV1, type SchemaSnapshotV2 } from "@typed-sql/schema";
import { parseDuckDBType } from "./native-types.js";
import { DUCKDB_DIALECT_VERSION } from "./version.js";
export type DuckDBSchemaSnapshot = (SchemaSnapshotV1 | SchemaSnapshotV2) & { readonly dialect: "duckdb" };
export function parseDuckDBSchemaSnapshot(value: unknown): DuckDBSchemaSnapshot {
  const snapshot = parseSchemaSnapshot(value);
  if (snapshot.dialect !== "duckdb") throw new TypeError("Expected a DuckDB schema snapshot");
  if (snapshot.dialectVersion !== undefined && snapshot.dialectVersion !== DUCKDB_DIALECT_VERSION)
    throw new TypeError("DuckDB grammar version differs from snapshot");
  if (snapshot.server !== undefined && snapshot.server.product !== "duckdb")
    throw new TypeError("DuckDB snapshot has different server product");
  for (const table of Object.values(snapshot.tables))
    for (const column of Object.values(table.columns)) parseDuckDBType(column.databaseType);
  return snapshot as DuckDBSchemaSnapshot;
}
export function duckDBRelationIdentity(catalog: string, schema: string, name: string): string {
  return [catalog, schema, name].map((part) => `"${part.replaceAll('"', '""')}"`).join(".");
}
