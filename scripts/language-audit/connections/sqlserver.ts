import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describeSqlServer } from "../native.mjs";
import type { AuditConnection, AuditConnectionOptions, AuditConnectionOwner } from "./contracts.js";

async function connect(options: AuditConnectionOptions): Promise<AuditConnection> {
  const environment = options.environment ?? process.env;
  if (!environment.TYPED_SQL_AUDIT_ODBC) throw new Error("TYPED_SQL_AUDIT_ODBC is required");
  const { createSqlServerOdbcDatabase } = await import("../../../packages/sqlserver/src/odbc.js");
  const require = createRequire(fileURLToPath(new URL("../../../e2e/sqlserver/package.json", import.meta.url)));
  const db = await createSqlServerOdbcDatabase({
    connectionString: environment.TYPED_SQL_AUDIT_ODBC,
    driverModulePath: require.resolve("koffi"),
  });
  return {
    target: { version: db.serverEvidence.version, settings: db.serverEvidence.settings },
    server: db.serverEvidence,
    query: (sql: string) => db.queryable.all(sql),
    prepare: (sql: string) => describeSqlServer(db.queryable, sql),
    close: () => db.close(),
  };
}

export const sqlserverConnection: AuditConnectionOwner = { id: "sqlserver", connect };
