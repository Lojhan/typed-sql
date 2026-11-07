import { duckdbMapper } from "../../../tools/grammar-catalog/src/mappers/duckdb.mjs";
import { inventory } from "../records.mjs";
import { legacyDiscoveryDefaults } from "./shared.mjs";

export const duckdbDiscovery = {
  ...duckdbMapper,
  ...legacyDiscoveryDefaults,
  discoveryQueries: () => ({
    functions: `SELECT function_name AS name, function_type AS kind, parameter_types AS arguments, parameters AS parameter_names,
      return_type AS result, varargs, stability, has_side_effects AS side_effects, internal, schema_name, alias_of, macro_definition
      FROM duckdb_functions() WHERE database_name='system'`,
    keywords: "SELECT keyword_name AS name, keyword_category AS category FROM duckdb_keywords()",
    types: "SELECT type_name AS name, logical_type, type_category AS category FROM duckdb_types() WHERE internal",
    operators: `SELECT function_name AS name, parameter_types AS arguments, return_type AS result
      FROM duckdb_functions() WHERE database_name='system' AND NOT regexp_matches(function_name, '^[a-zA-Z_]')`,
    collations: "SELECT collname AS name FROM pragma_collations()",
    settings: "SELECT name, input_type AS type, scope FROM duckdb_settings()",
    extensions: "SELECT extension_name AS name FROM duckdb_extensions()",
  }),
  discoveryRow: (category, row) => (category === "functions" ? canonicalDuckFunction(row) : row),
  async discoveryDerived({ categories, query }) {
    const types = [],
      rejected = [];
    for (const name of [...new Set(categories.types.rows.map((row) => row.name))].sort()) {
      if (!/^[a-z_][a-z_0-9]*$/iu.test(name)) {
        rejected.push(name);
        continue;
      }
      try {
        await query(`SELECT CAST(NULL AS "${name}")`);
        types.push(name);
      } catch (error) {
        if (
          !/^(?:(?:Binder|Catalog|Parser|Conversion|Invalid Type|Not implemented) Error:|Unexpected type id: \d+$)/iu.test(
            String(error?.message),
          )
        )
          throw error;
        rejected.push(name);
      }
    }
    const statements = types.flatMap((source) =>
      types.map(
        (target) =>
          `SELECT '${source} -> ${target}' AS name, can_cast_implicitly(CAST(NULL AS "${source}"), CAST(NULL AS "${target}")) AS implicit`,
      ),
    );
    const rows = [];
    for (let index = 0; index < statements.length; index += 64)
      rows.push(...(await query(statements.slice(index, index + 64).join(" UNION ALL "))));
    categories.casts = {
      ...inventory(
        rows,
        "can_cast_implicitly over independently enumerated types",
        "implicit-only; explicit and contextual casts unverified",
      ),
      unprobeableTypes: rejected,
    };
  },
};

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
// Named table/pragma options come from an unordered map; their order is not positional SQL.
// Preserve positional colN slots and fingerprint every named option's name/type association.
export function canonicalDuckFunction(row) {
  if (!["table", "pragma"].includes(row.kind)) return row;
  if (!Array.isArray(row.parameter_names) || row.parameter_names.length !== row.arguments?.length)
    throw new Error(`Incomplete DuckDB parameter metadata: ${row.name}`);
  const positional = [],
    named = [];
  for (let index = 0; index < row.parameter_names.length; index++) {
    const name = row.parameter_names[index],
      type = row.arguments[index];
    if (/^col\d+$/u.test(name)) positional.push([name, type]);
    else named.push([name, type]);
  }
  positional.sort(([a], [b]) => Number(a.slice(3)) - Number(b.slice(3)));
  named.sort(([a], [b]) => compare(a, b));
  return {
    ...row,
    arguments: positional.map(([, type]) => type),
    parameter_names: positional.map(([name]) => name),
    named_arguments: Object.fromEntries(named),
  };
}
