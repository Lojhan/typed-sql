import { defineConfig, type LiveQueryVerifier, type QueryPlanInspector } from "@typed-sql/core";
import { sqlserver } from "@typed-sql/sqlserver/analysis";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import {
  createSqlServerLiveVerifier,
  createSqlServerPlanInspector,
  type SqlServerServicePool,
} from "@typed-sql/sqlserver/runtime";

const pool: SqlServerServicePool = {
  async acquire() {
    const db = await createSqlServerOdbcDatabase({ connectionString: () => process.env.SQLSERVER_CONNECTION_STRING! });
    return {
      all: (text, values) => db.queryable.all(text, values),
      release: () => db.close(),
      discard: () => db.close(),
    };
  },
};
const live: LiveQueryVerifier = createSqlServerLiveVerifier({ pool });
const inspector: QueryPlanInspector = createSqlServerPlanInspector({ pool });
export default defineConfig({
  dialect: sqlserver(),
  outDir: "generated/db",
  schema: { file: "generated/db/schema.json" },
  verification: { live },
  plans: { live: inspector },
});
