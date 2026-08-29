import { defineConfig } from "@typed-sql/core";
import { sqlite, typePolicy } from "@typed-sql/sqlite";
import { nodeSqlite } from "@typed-sql/sqlite/node-sqlite";

export const databasePath = new URL("./example.sqlite", import.meta.url);

export default defineConfig({
  dialect: sqlite({ typePolicy }),
  schema: {
    file: "generated/db/schema.json",
    provider: nodeSqlite({ path: databasePath, typePolicy }),
  },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
});
