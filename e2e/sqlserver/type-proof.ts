import { createSqlServerMsnodesqlv8Database } from "@typed-sql/sqlserver/msnodesqlv8";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import koffi from "koffi";
import native from "msnodesqlv8";

// Applications own the real pinned SDKs; no casts or ambient replacements.
export const injectedDriver = () =>
  createSqlServerOdbcDatabase({ connectionString: "application-owned", driverImporter: async () => koffi });
export const compatibilityDriver = () =>
  createSqlServerMsnodesqlv8Database({ connectionString: "application-owned", driverImporter: async () => native });
export const defaultDriver = () => createSqlServerOdbcDatabase({ connectionString: "application-owned" });
