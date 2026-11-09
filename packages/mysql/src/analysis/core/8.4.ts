import { createMySqlDialect } from "../../analysis-factory.js";
import catalog from "../../catalog/generated/8.4.js";
import { routineSeries } from "../../catalog/generated/availability.js";
import { createMySqlCatalogProvider } from "../../catalog/provider.js";
import type { MySqlProfileOptions } from "../../profile.js";
import { vocabulary } from "../../vocabulary/generated/8.4.js";

export type { MySqlProfileOptions as MySqlCoreOptions } from "../../profile.js";

const owner = createMySqlCatalogProvider([catalog], { routineSeries });
export function mysql(options: MySqlProfileOptions = {}) {
  return createMySqlDialect(owner, options, "8.4", true, () => vocabulary);
}
