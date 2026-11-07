import { duckdbAudit } from "./duckdb.js";
import { mysqlAudit } from "./mysql.js";
import { postgresAudit } from "./postgres.js";
import { createAuditGrammarRegistry } from "./registry.js";
import { sqliteAudit } from "./sqlite.js";
import { sqlserverAudit } from "./sqlserver.js";

export const builtinAuditGrammars = createAuditGrammarRegistry([
  postgresAudit,
  mysqlAudit,
  sqliteAudit,
  sqlserverAudit,
  duckdbAudit,
]);
