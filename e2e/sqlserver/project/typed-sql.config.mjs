import { appendFileSync } from "node:fs";
import { defineConfig } from "@typed-sql/core";
import { sqlserver, typePolicy } from "@typed-sql/sqlserver";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import { createSqlServerLiveVerifier, createSqlServerPlanInspector } from "@typed-sql/sqlserver/runtime";
import { connectionString } from "./connection.mjs";
export const native = {
  connectionString: () => connectionString(),
  typePolicy,
  async driverImporter() {
    appendFileSync("native-imports.log", "SDK initialized\n");
    return (await import("koffi")).default;
  },
};
// Each lease owns a fresh, canonically configured physical connection. Constructing
// the pool and the two synchronous services performs no import or database I/O.
const pool = {
  async acquire() {
    const database = await createSqlServerOdbcDatabase(native);
    let closing;
    const close = () => (closing ??= database.close());
    return { all: (text, values) => database.queryable.all(text, values), release: close, discard: close };
  },
};
export default defineConfig({
  dialect: sqlserver({ typePolicy }),
  schema: { file: "generated/db/schema.json" },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
  verification: { live: createSqlServerLiveVerifier({ pool, typePolicy }) },
  plans: { live: createSqlServerPlanInspector({ pool }) },
});
