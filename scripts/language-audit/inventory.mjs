import { builtinMappers } from "../../tools/grammar-catalog/src/mappers/index.mjs";
import { canonical, hash } from "./hash.mjs";
import { signatureFacts } from "./signatures.mjs";

export { hash } from "./hash.mjs";

export const CATEGORIES = Object.freeze([
  "functions",
  "keywords",
  "types",
  "operators",
  "casts",
  "collations",
  "settings",
  "extensions",
  "syntax",
]);
export const DIALECTS = Object.freeze(["postgres", "mysql", "sqlite", "sqlserver", "duckdb"]);
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export function reviewTarget(input, registry = builtinMappers) {
  return registry.get(input.dialect).reviewTarget?.(input.target) ?? input.target;
}

// One signature/observation per line keeps generated evidence reviewable.
export function serialize(value, indent = 0) {
  const padding = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const flat = (item) =>
      item === null ||
      typeof item !== "object" ||
      typeof item.sql === "string" ||
      Boolean(item.signature) ||
      (Array.isArray(item)
        ? item.every((entry) => entry === null || typeof entry !== "object")
        : Object.values(item).every(
            (entry) =>
              entry === null ||
              typeof entry !== "object" ||
              (Array.isArray(entry) && entry.every((child) => child === null || typeof child !== "object")),
          ));
    return `[\n${value.map((item) => `${padding}  ${flat(item) ? JSON.stringify(item) : serialize(item, indent + 2)}`).join(",\n")}\n${padding}]`;
  }
  if (value && typeof value === "object") {
    if (typeof value.sql === "string" || value.signature) return JSON.stringify(value);
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([key, item]) => `${padding}  ${JSON.stringify(key)}: ${serialize(item, indent + 2)}`).join(",\n")}\n${padding}}`;
  }
  return JSON.stringify(value);
}

export function inventory(rows, source, scope = "engine") {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`Empty inventory: ${source}`);
  const values = [
    ...new Map(
      rows.map((row) => {
        if (typeof row.name !== "string" || !row.name.trim()) throw new Error(`Missing inventory name: ${source}`);
        const normalized = canonical(row);
        return [JSON.stringify(normalized), normalized];
      }),
    ).values(),
  ].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  return { status: "observed", scope, source, fingerprint: hash(values), rows: values };
}

export const unavailable = (reason) => ({ status: "unavailable", reason });

// Read-only discovery. A failed supported query is an error, never an empty/unsupported inventory.
// These queries enumerate upstream metadata rather than asking whether our existing names exist.
export const QUERIES = {
  postgres: {
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
  },
  mysql: {
    keywords: "SELECT WORD AS name, RESERVED AS reserved FROM information_schema.KEYWORDS",
    collations: `SELECT COLLATION_NAME AS name, CHARACTER_SET_NAME AS character_set,
      IS_DEFAULT AS is_default, SORTLEN AS sort_length FROM information_schema.COLLATIONS`,
    settings: "SHOW GLOBAL VARIABLES",
    types: "HELP 'Data Types'",
    syntax: "HELP '%'",
  },
  sqlite: {
    functions: "SELECT name, builtin, type AS kind, enc AS encoding, narg AS arity, flags FROM pragma_function_list",
    collations: "SELECT name FROM pragma_collation_list",
    settings: "SELECT name FROM pragma_pragma_list",
  },
  sqlserver: {
    functions: `SELECT o.name, SCHEMA_NAME(o.schema_id) AS namespace, o.type AS kind,
      (SELECT COUNT(*) FROM sys.parameters p WHERE p.object_id=o.object_id AND p.parameter_id>0) AS arity,
      OBJECTPROPERTY(o.object_id,'IsDeterministic') AS deterministic,
      (SELECT p.parameter_id AS position, p.name, t.name AS type_name, SCHEMA_NAME(t.schema_id) AS type_schema,
        p.max_length, p.precision, p.scale, p.is_output, p.is_nullable, p.is_readonly, p.has_default_value,
        CONVERT(nvarchar(128),SQL_VARIANT_PROPERTY(p.default_value,'BaseType')) AS default_value_type,
        CONVERT(varchar(max),CONVERT(varbinary(max),p.default_value),2) AS default_value_binary_hex
        FROM sys.parameters p LEFT JOIN sys.types t ON t.user_type_id=p.user_type_id WHERE p.object_id=o.object_id
        ORDER BY p.parameter_id FOR JSON PATH, INCLUDE_NULL_VALUES) AS parameters_json,
      (SELECT c.column_id AS position, c.name, t.name AS type_name, SCHEMA_NAME(t.schema_id) AS type_schema,
        c.max_length, c.precision, c.scale, c.is_nullable FROM sys.columns c LEFT JOIN sys.types t ON t.user_type_id=c.user_type_id
        WHERE c.object_id=o.object_id ORDER BY c.column_id FOR JSON PATH, INCLUDE_NULL_VALUES) AS return_columns_json
      FROM sys.system_objects o WHERE o.type IN ('FN','IF','TF','FS','FT','AF')`,
    types: "SELECT name, system_type_id, max_length, precision, scale FROM sys.types WHERE is_user_defined=0",
    collations: "SELECT name FROM sys.fn_helpcollations()",
    settings:
      "SELECT name, CONVERT(bigint,minimum) AS minimum, CONVERT(bigint,maximum) AS maximum, is_dynamic, is_advanced FROM sys.configurations",
  },
  duckdb: {
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
  },
};

const LIMITATIONS = {
  functions:
    "No complete native-function enumeration in this engine; use the independent official reference inventory. SQL Server system objects omit parser built-ins.",
  keywords:
    "No SQL metadata query enumerates keywords; use the official keyword reference (SQLite also exposes a C API).",
  types:
    "No complete named-type enumeration through SQL metadata. SQLite accepts arbitrary declared types and uses affinities; use the official type reference.",
  operators: "No complete operator enumeration through SQL metadata; use the official operator reference.",
  casts: "No complete cast enumeration through SQL metadata; contextual coercions require generated behavioral probes.",
  collations: "No complete collation enumeration through SQL metadata.",
  settings: "No complete setting enumeration through SQL metadata.",
  extensions: "No complete extension enumeration through SQL metadata; installed functions are captured separately.",
  syntax:
    "Catalogs cannot enumerate SQL productions. Official statement/reference inventories and behavioral conformance probes are required.",
};

export async function collectLive(dialect, query, target) {
  if (!DIALECTS.includes(dialect)) throw new Error(`Unknown dialect ${dialect}`);
  if (typeof target.version !== "string" || !target.version) throw new Error("Actual engine version is required");
  /** @type {Record<string, {status: string, scope?: string, source?: string, fingerprint?: string, rows?: {name: string, [key: string]: unknown}[], reason?: string, unprobeableTypes?: string[]}>} */
  const categories = {};
  for (const category of CATEGORIES) {
    const sql = QUERIES[dialect][category];
    categories[category] = sql
      ? inventory(
          (await query(sql)).map((row) => {
            if (category === "functions") {
              const native = dialect === "duckdb" ? canonicalDuckFunction(row) : row;
              return { ...native, signature: signatureFacts(dialect, native) };
            }
            if (dialect === "mysql" && category === "settings") return { name: row.Variable_name };
            if (dialect === "mysql" && ["types", "syntax"].includes(category))
              return {
                name: row.name,
                ...(row.is_it_category === undefined ? {} : { is_category: row.is_it_category }),
              };
            return row;
          }),
          sql,
          dialect === "sqlserver" && category === "functions"
            ? "system-objects-only"
            : dialect === "mysql" && ["types", "syntax"].includes(category)
              ? "vendor-help-topics; documentation is not complete SQL grammar enumeration"
              : "engine",
        )
      : unavailable(LIMITATIONS[category]);
  }
  if (dialect === "duckdb") {
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
      } catch {
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
  }
  return { formatVersion: 1, dialect, target, categories };
}

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

export function diffInventory(previous, next) {
  if (previous.dialect !== next.dialect || previous.target.version !== next.target.version)
    throw new Error("Inventory targets must match exactly");
  const changes = [];
  if (hash(reviewTarget(previous)) !== hash(reviewTarget(next)))
    changes.push({ category: "target", kind: "context-changed", before: previous.target, after: next.target });
  if (hash(previous.recognition ?? null) !== hash(next.recognition ?? null))
    changes.push({
      category: "recognition",
      kind: "behavior-changed",
      before: previous.recognition ?? null,
      after: next.recognition ?? null,
    });
  for (const category of CATEGORIES) {
    const left = previous.categories[category],
      right = next.categories[category];
    if (!left || !right) throw new Error(`Missing category ${category}`);
    if (left.status !== right.status)
      changes.push({ category, kind: "coverage-changed", before: left.status, after: right.status });
    if (left.status === "unavailable" && right.status === "unavailable" && left.reason !== right.reason)
      changes.push({ category, kind: "limitation-changed", before: left.reason, after: right.reason });
    if (left.status === "observed" && right.status === "observed") {
      if (left.scope !== right.scope || hash(left.unprobeableTypes ?? []) !== hash(right.unprobeableTypes ?? []))
        changes.push({ category, kind: "coverage-changed", before: left.scope, after: right.scope });
      const a = new Set(left.rows.map((row) => JSON.stringify(row)));
      const b = new Set(right.rows.map((row) => JSON.stringify(row)));
      for (const value of b) if (!a.has(value)) changes.push({ category, kind: "added", value: JSON.parse(value) });
      for (const value of a) if (!b.has(value)) changes.push({ category, kind: "removed", value: JSON.parse(value) });
    }
  }
  return changes;
}
