import { duckdbDiscovery } from "./duckdb.mjs";
import { mysqlDiscovery } from "./mysql.mjs";
import { postgresDiscovery } from "./postgres.mjs";
import { createDiscoveryRegistry } from "./registry.mjs";
import { sqliteDiscovery } from "./sqlite.mjs";
import { sqlserverDiscovery } from "./sqlserver.mjs";
export const builtinDiscoveryRegistry = createDiscoveryRegistry([
  postgresDiscovery,
  mysqlDiscovery,
  sqliteDiscovery,
  sqlserverDiscovery,
  duckdbDiscovery,
]);
