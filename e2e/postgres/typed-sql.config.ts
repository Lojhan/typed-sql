import { defineConfig } from "@typed-sql/core";
import { postgres, typePolicy } from "@typed-sql/postgres";
import { createPgLiveVerifier, pg } from "@typed-sql/postgres/pg";

const dialect = postgres({ typePolicy });
const connectionString = () => {
  const port = process.env.TYPED_SQL_E2E_PORT ?? "55432";
  return `postgresql://typed_sql:typed_sql_e2e@127.0.0.1:${port}/typed_sql_e2e`;
};

export default defineConfig({
  dialect,
  schema: {
    file: "./generated/db/schema.json",
    provider: pg({
      connectionString,
      schemas: ["public"],
      typePolicy,
    }),
  },
  outDir: "./generated/db",
  projects: ["./tsconfig.json"],
  typePolicy,
  manifest: { outFile: ".typed-sql/queries.json" },
  verification: {
    live: createPgLiveVerifier({ connectionString, typePolicy }),
    proofFile: ".typed-sql/verification.json",
    concurrency: 2,
  },
});
