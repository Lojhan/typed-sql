import { defineConfig } from "@typed-sql/core";
import { nodeDuckDB } from "@typed-sql/duckdb/node-api";
import offline, { native } from "./typed-sql.config.mjs";
// Native I/O is intentional only for this separate provider-backed generation step.
export default defineConfig({ ...offline, schema: { ...offline.schema, provider: nodeDuckDB(native) } });
