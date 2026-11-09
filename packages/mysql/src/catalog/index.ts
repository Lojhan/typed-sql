import catalog84 from "./generated/8.4.js";
import catalog97 from "./generated/9.7.js";
import catalog267 from "./generated/26.7.js";
import { createMySqlCatalogProvider } from "./provider.js";

export { normalizeMySqlType } from "./provider.js";
export type {
  MySqlCatalogCoercion,
  MySqlCatalogCollation,
  MySqlCatalogOperatorFamily,
  MySqlCatalogRoutineFamily,
  MySqlCatalogType,
  MySqlCatalogTypeMapping,
  MySqlCoercionContext,
  MySqlCoercionSafety,
  MySqlCoreCatalog,
  MySqlOperatorResultRule,
  MySqlRoutineResultRule,
  MySqlTypeCategory,
} from "./types.js";
export const MYSQL_CORE_CATALOG_FORMAT_VERSION = 1 as const;
export const defaultMySqlCatalog = createMySqlCatalogProvider([catalog84, catalog97, catalog267]);
export const {
  catalog: mySqlCoreCatalog,
  forSchema: mySqlCoreCatalogForSchema,
  type: mySqlCatalogType,
  coercion: mySqlCatalogCoercion,
  canCoerce: mySqlCatalogCanCoerce,
  operator: mySqlCatalogOperator,
  routine: mySqlCatalogRoutine,
  collation: mySqlCatalogCollation,
  hasRoutineInAnotherSeries: mySqlCatalogHasRoutineInAnotherSeries,
} = defaultMySqlCatalog;
