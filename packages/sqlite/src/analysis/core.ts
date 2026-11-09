import { createSqliteDialect } from "../analysis-factory.js";
import type { SqliteProfileOptions } from "../profile.js";

export type { SqliteProfileOptions as SqliteCoreOptions } from "../profile.js";
export function sqlite(options: SqliteProfileOptions = {}) {
  return createSqliteDialect(options, true);
}
