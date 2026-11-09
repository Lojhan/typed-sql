import { routineSeries } from "../../catalog/generated/availability.js";
import catalog, { prefixes, selection } from "../../catalog/generated/core/8.4.js";
import { createMySqlCatalogProvider } from "../../catalog/provider.js";
import { createMySqlCoreDialect, type MySqlCoreOptions } from "../../offline-packs.js";

export type { MySqlCoreOptions, MySqlOfflinePack } from "../../offline-packs.js";

const owner = createMySqlCatalogProvider([catalog], { routineSeries, selection, prefixes });
export function mysql(options: MySqlCoreOptions = {}) {
  return createMySqlCoreDialect(owner, "8.4", options);
}
