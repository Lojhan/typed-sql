import { defineConfig } from "@typed-sql/core";
import { postgres } from "@typed-sql/postgres";
import { pg } from "@typed-sql/postgres/pg";

const dialect = postgres();

export default defineConfig({
  dialect,
  schema: {
    file: "./generated/db/schema.json",
    provider: pg({
      connectionString: () => {
        const port = process.env.TYPED_SQL_E2E_PORT ?? "55432";
        return `postgresql://typed_sql:typed_sql_e2e@127.0.0.1:${port}/typed_sql_e2e`;
      },
      schemas: ["public"],
      typePolicy: dialect.defaultTypePolicy,
    }),
  },
  outDir: "./generated/db",
  projects: ["./tsconfig.json"],
  typePolicy: dialect.defaultTypePolicy,
});
