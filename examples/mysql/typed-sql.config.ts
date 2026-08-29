import { defineConfig } from "@typed-sql/core";
import { mysql, typePolicy } from "@typed-sql/mysql";
import { mysql2 } from "@typed-sql/mysql/mysql2";

export const connectionUri = () =>
  process.env.DATABASE_URL ?? "mysql://typed_sql:typed_sql_examples@127.0.0.1:53311/typed_sql_examples";

export default defineConfig({
  dialect: mysql({ typePolicy }),
  schema: {
    file: "generated/db/schema.json",
    provider: mysql2({ connectionUri, schemas: ["typed_sql_examples"], typePolicy }),
  },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
});
