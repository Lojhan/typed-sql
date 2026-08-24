import { defineConfig } from "@typed-sql/core";
import { mysql, typePolicy } from "@typed-sql/mysql";
import { mysql2 } from "@typed-sql/mysql/mysql2";

const dialect = mysql({ typePolicy });

export default defineConfig({
  dialect,
  schema: {
    file: "./generated/db/schema.json",
    provider: mysql2({
      connectionUri: () => {
        const port = process.env.TYPED_SQL_MYSQL_E2E_PORT ?? "53306";
        return `mysql://typed_sql:typed_sql_e2e@127.0.0.1:${port}/typed_sql_e2e`;
      },
      schemas: ["typed_sql_e2e"],
      typePolicy,
    }),
  },
  outDir: "./generated/db",
  projects: ["./tsconfig.json"],
  typePolicy,
});
