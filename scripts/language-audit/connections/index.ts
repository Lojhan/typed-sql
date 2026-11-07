import { duckdbConnection } from "./duckdb.js";
import { mysqlConnection } from "./mysql.js";
import { postgresConnection } from "./postgres.js";
import { createAuditConnectionRegistry } from "./registry.js";
import { sqliteConnection } from "./sqlite.js";
import { sqlserverConnection } from "./sqlserver.js";

export const builtinAuditConnections = createAuditConnectionRegistry([
  postgresConnection,
  mysqlConnection,
  sqliteConnection,
  sqlserverConnection,
  duckdbConnection,
]);
