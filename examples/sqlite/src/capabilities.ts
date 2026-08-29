import type { SqliteDatabase } from "@typed-sql/sqlite/runtime";

export function sqliteExecutionCapabilities(database: SqliteDatabase) {
  return database.executionCapabilities;
}
