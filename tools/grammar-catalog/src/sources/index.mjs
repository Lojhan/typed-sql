import { createMapperRegistry } from "../registry.mjs";
import { refreshDuckDBSources } from "./duckdb/refresh.mjs";
import { refreshSQLiteSources } from "./sqlite/refresh.mjs";
export const vendorSourceOwners = createMapperRegistry(
  [
    { id: "sqlite", refresh: refreshSQLiteSources },
    { id: "duckdb", refresh: refreshDuckDBSources },
  ],
  {
    methods: ["refresh"],
  },
);
