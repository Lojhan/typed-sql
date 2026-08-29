import { defineConfig } from "@typed-sql/core";
import { postgres, typePolicy } from "@typed-sql/postgres";
import { pg } from "@typed-sql/postgres/pg";

export const connectionString = () =>
  process.env.POSTGRES_DATABASE_URL ?? "postgresql://typed_sql:typed_sql_examples@127.0.0.1:55442/typed_sql_multi";

export default defineConfig({
  dialect: postgres({ typePolicy }),
  schema: {
    file: "generated/db/schema.json",
    provider: pg({ connectionString, schemas: ["public"], typePolicy }),
  },
  outDir: "generated/db",
  projects: ["../tsconfig.json"],
  typePolicy,
});
