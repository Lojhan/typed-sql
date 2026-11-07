import { postgresMapper } from "../../../tools/grammar-catalog/src/mappers/postgres.mjs";
import { legacyDiscoveryDefaults } from "./shared.mjs";

export const postgresDiscovery = {
  ...postgresMapper,
  ...legacyDiscoveryDefaults,
  discoveryQueries: () => ({
    functions: `SELECT p.proname AS name, n.nspname AS namespace, p.prokind AS kind,
      pg_get_function_identity_arguments(p.oid) AS arguments, pg_get_function_result(p.oid) AS result,
      ARRAY(SELECT format_type(t,NULL) FROM unnest(p.proargtypes) t) AS argument_types,
      rt.typtype AS result_type_kind, p.proretset AS returns_set,
      n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')' AS identity,
      p.proargnames AS parameter_names, p.proargmodes::text[] AS parameter_modes, p.pronargs AS input_count,
      ARRAY(SELECT format_type(t,NULL) FROM unnest(COALESCE(p.proallargtypes,p.proargtypes::oid[])) t) AS all_argument_types,
      p.pronargdefaults AS defaults, pg_get_expr(p.proargdefaults,0) AS default_expressions_sql,
      p.provariadic <> 0 AS variadic, CASE WHEN p.provariadic=0 THEN NULL ELSE format_type(p.provariadic,NULL) END AS variadic_type,
      p.proisstrict AS strict, p.provolatile AS volatility, p.proparallel AS parallel
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_type rt ON rt.oid=p.prorettype WHERE n.nspname='pg_catalog'`,
    keywords: "SELECT word AS name, catcode AS category, catdesc AS description FROM pg_get_keywords()",
    types: `SELECT t.typname AS name, format_type(t.oid,NULL) AS canonical_name,
      t.typtype AS kind, t.typcategory AS category, t.typispreferred AS preferred, t.typisdefined AS defined
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='pg_catalog'`,
    operators: `SELECT o.oprname AS name, format_type(o.oprleft,NULL) AS left_type,
      format_type(o.oprright,NULL) AS right_type, format_type(o.oprresult,NULL) AS result
      FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace WHERE n.nspname='pg_catalog'`,
    casts: `SELECT format_type(castsource,NULL)||' -> '||format_type(casttarget,NULL) AS name,
      castcontext AS context, castmethod AS method FROM pg_cast`,
    collations: "SELECT collname AS name, collprovider AS provider, collencoding AS encoding FROM pg_collation",
    settings: "SELECT name, vartype AS type, context, enumvals FROM pg_settings",
    extensions: "SELECT name, default_version FROM pg_available_extensions",
  }),
};
