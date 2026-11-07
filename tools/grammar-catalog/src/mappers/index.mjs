import { createMapperRegistry } from "../registry.mjs";
import { duckdbMapper } from "./duckdb.mjs";
import { mysqlMapper } from "./mysql.mjs";
import { postgresMapper } from "./postgres.mjs";
import { sqliteMapper } from "./sqlite.mjs";
import { sqlServerMapper } from "./sqlserver.mjs";

// Composition root only. The registry/model have no built-in grammar cases.
export const builtinMappers = createMapperRegistry([
  postgresMapper,
  mysqlMapper,
  sqliteMapper,
  sqlServerMapper,
  duckdbMapper,
]);
