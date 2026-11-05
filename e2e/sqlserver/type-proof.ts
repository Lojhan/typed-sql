import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import native from "msnodesqlv8";

// The application installs and owns the real pinned SDK. Its published types
// must work with the explicit adapter without casts or ambient replacements.
export const injectedDriver = () =>
  createSqlServerOdbcDatabase({ connectionString: "application-owned", driverImporter: async () => native });

export const defaultDriver = () => createSqlServerOdbcDatabase({ connectionString: "application-owned" });
