import { duckdbMapper } from "../mappers/duckdb.mjs";
import { mysqlMapper } from "../mappers/mysql.mjs";
import { postgresMapper } from "../mappers/postgres.mjs";
import { sqliteMapper } from "../mappers/sqlite.mjs";
import { sqlServerMapper } from "../mappers/sqlserver.mjs";
import { createMapperRegistry } from "../registry.mjs";
import { generateCatalog as duckdb } from "./duckdb.mjs";
import { generateCatalog as mysql } from "./mysql.mjs";
import { generateCatalog as postgres } from "./postgres.mjs";
import { generateCatalog as sqlite } from "./sqlite.mjs";
import { generateCatalog as sqlserver } from "./sqlserver.mjs";

// Composition only. Adding a mapper/emitter does not change generation mechanics.
export const builtinGenerators = createMapperRegistry([
  { ...postgresMapper, generateCatalog: postgres },
  { ...mysqlMapper, generateCatalog: mysql },
  { ...sqliteMapper, generateCatalog: sqlite },
  { ...sqlServerMapper, generateCatalog: sqlserver },
  { ...duckdbMapper, generateCatalog: duckdb },
]);
