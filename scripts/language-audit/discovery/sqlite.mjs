import { sqliteMapper } from "../../../tools/grammar-catalog/src/mappers/sqlite.mjs";
import { legacyDiscoveryDefaults } from "./shared.mjs";

export const sqliteDiscovery = {
  ...sqliteMapper,
  ...legacyDiscoveryDefaults,
  discoveryQueries: () => ({
    functions: "SELECT name, builtin, type AS kind, enc AS encoding, narg AS arity, flags FROM pragma_function_list",
    collations: "SELECT name FROM pragma_collation_list",
    settings: "SELECT name FROM pragma_pragma_list",
  }),
};
