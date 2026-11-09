import { createSqlServerDialect } from "../analysis-factory.js";
import type { SqlServerProfileOptions } from "../profile.js";

export type { SqlServerProfileOptions as SqlServerCoreOptions } from "../profile.js";
export function sqlserver(options: SqlServerProfileOptions = {}) {
  return createSqlServerDialect(options, true);
}
