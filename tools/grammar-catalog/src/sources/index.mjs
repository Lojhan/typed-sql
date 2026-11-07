import { createMapperRegistry } from "../registry.mjs";
import { refreshDuckDBSources } from "./duckdb/refresh.mjs";
import { refreshMySQLSources } from "./mysql/refresh.mjs";
import { refreshPostgresSources } from "./postgres/refresh.mjs";
import { refreshSQLiteSources } from "./sqlite/refresh.mjs";
export const vendorSourceOwners = createMapperRegistry(
  [
    { id: "sqlite", refresh: refreshSQLiteSources },
    { id: "duckdb", refresh: refreshDuckDBSources },
    { id: "postgres", refresh: refreshPostgresSources },
    { id: "mysql", refresh: refreshMySQLSources },
  ],
  {
    methods: ["refresh"],
  },
);
