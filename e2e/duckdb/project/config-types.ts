import { defineConfig, type LiveQueryVerifier, type QueryPlanInspector } from "@typed-sql/core";
import { duckdb } from "@typed-sql/duckdb/analysis";
import { createNodeDuckDBLiveVerifier, createNodeDuckDBPlanInspector } from "@typed-sql/duckdb/node-api";

const native = { path: "persistent.duckdb" };
const live: LiveQueryVerifier = createNodeDuckDBLiveVerifier(native);
const inspector: QueryPlanInspector = createNodeDuckDBPlanInspector(native);
export default defineConfig({
  dialect: duckdb(),
  schema: { file: "schema.json" },
  outDir: "generated/db",
  verification: { live },
  plans: { live: inspector },
});
