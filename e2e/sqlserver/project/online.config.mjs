import { defineConfig } from "@typed-sql/core";
import { sqlServerOdbc } from "@typed-sql/sqlserver/odbc";
import offline, { native } from "./typed-sql.config.mjs";
export default defineConfig({
  ...offline,
  schema: { ...offline.schema, provider: sqlServerOdbc({ ...native, includeSchemas: ["dbo"] }) },
});
