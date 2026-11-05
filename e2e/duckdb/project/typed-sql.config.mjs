import { appendFileSync } from "node:fs";
import { defineConfig } from "@typed-sql/core";
import { duckdb } from "@typed-sql/duckdb";
import { createNodeDuckDBLiveVerifier, createNodeDuckDBPlanInspector } from "@typed-sql/duckdb/node-api";

export const native = {
  path: process.env.TYPED_SQL_DUCKDB_PATH ?? "persistent.duckdb",
  async sdkImporter() {
    appendFileSync("native-imports.log", "SDK initialized\n");
    return import("@duckdb/node-api");
  },
};
export default defineConfig({
  dialect: duckdb(),
  schema: { file: "schema.json" },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  verification: { live: createNodeDuckDBLiveVerifier(native) },
  plans: { live: createNodeDuckDBPlanInspector(native) },
});
