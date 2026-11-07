import { DUCKDB_SUPPORT_POLICY } from "../../../packages/duckdb/src/support.js";
import { mysqlReferenceSource } from "./mysql.js";
import { postgresReferenceSource } from "./postgres.js";
import { createReferenceSourceRegistry } from "./registry.js";
import { sqliteReferenceSource } from "./sqlite.js";
import { sqlserverReferenceSource } from "./sqlserver.js";

export const builtinReferenceSources = createReferenceSourceRegistry([
  postgresReferenceSource,
  mysqlReferenceSource,
  {
    id: "duckdb",
    referenceVersions: () => [],
    captureVersions: () => DUCKDB_SUPPORT_POLICY.qualifiedEngines,
    minimumFunctions: 0,
    scope: "Retained native captures; documentation-reference refresh is not available.",
  },
  sqliteReferenceSource,
  sqlserverReferenceSource,
]);
