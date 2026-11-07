import { mysqlMapper } from "../../../tools/grammar-catalog/src/mappers/mysql.mjs";
import { legacyDiscoveryDefaults } from "./shared.mjs";

export const mysqlDiscovery = {
  ...mysqlMapper,
  ...legacyDiscoveryDefaults,
  discoveryQueries: () => ({
    keywords: "SELECT WORD AS name, RESERVED AS reserved FROM information_schema.KEYWORDS",
    collations: `SELECT COLLATION_NAME AS name, CHARACTER_SET_NAME AS character_set,
      IS_DEFAULT AS is_default, SORTLEN AS sort_length FROM information_schema.COLLATIONS`,
    settings: "SHOW GLOBAL VARIABLES",
    types: "HELP 'Data Types'",
    syntax: "HELP '%'",
  }),
  discoveryRow(category, row) {
    if (category === "settings") return { name: row.Variable_name };
    if (["types", "syntax"].includes(category))
      return { name: row.name, ...(row.is_it_category === undefined ? {} : { is_category: row.is_it_category }) };
    return row;
  },
  discoveryScope: (category) =>
    ["types", "syntax"].includes(category)
      ? "vendor-help-topics; documentation is not complete SQL grammar enumeration"
      : "engine",
};
