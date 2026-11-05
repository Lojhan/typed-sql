import { parseSchemaSnapshot, type SchemaSnapshotV1, type SchemaSnapshotV2 } from "@typed-sql/schema";
import { assertSqlServerServerEvidence } from "./capabilities.js";
import { parseSqlServerNativeType } from "./native-types.js";
import { SQLSERVER_DIALECT_VERSION } from "./version.js";
export type SqlServerSchemaSnapshot = (SchemaSnapshotV1 | SchemaSnapshotV2) & { readonly dialect: "sqlserver" };
export function parseSqlServerSchemaSnapshot(value: unknown): SqlServerSchemaSnapshot {
  const snapshot = parseSchemaSnapshot(value);
  if (snapshot.dialect !== "sqlserver") throw new TypeError("SQL Server snapshot must use dialect sqlserver");
  if (snapshot.dialectVersion !== undefined && snapshot.dialectVersion !== SQLSERVER_DIALECT_VERSION)
    throw new TypeError("Incompatible SQL Server grammar snapshot version");
  if (snapshot.server) assertSqlServerServerEvidence(snapshot.server);
  for (const table of Object.values(snapshot.tables))
    for (const column of Object.values(table.columns)) {
      if (column.databaseType.length > 256) throw new TypeError("SQL Server native type exceeds metadata bound");
      const native = parseSqlServerNativeType(column.databaseType);
      if (!native && !/[a-z\p{L}_][a-z\p{L}\p{N}_.[\] ]{0,255}/iu.test(column.databaseType))
        throw new TypeError("Invalid opaque SQL Server type identity");
    }
  return snapshot as SqlServerSchemaSnapshot;
}
