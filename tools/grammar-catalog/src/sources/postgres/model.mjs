import { postgresMapper } from "../../mappers/postgres.mjs";
import { describeRoutine } from "../../model/build.mjs";
import { routineSignature } from "../../model/routines.mjs";
import { parseRoutine } from "../../model/schema.mjs";
import { grammarTypeAliases } from "./grammar-aliases.mjs";
import { installationHeaders } from "./sql-headers.mjs";

/** Parse the one-dimensional catalog array notation; unfamiliar/nested forms fail closed. */
export function catalogArray(value) {
  if (value === "_null_") return null;
  if (typeof value !== "string" || !value.startsWith("{") || !value.endsWith("}"))
    throw new TypeError("Invalid PostgreSQL catalog array");
  if (value === "{}") return [];
  const result = [];
  let cursor = 1;
  while (cursor < value.length - 1) {
    while (/\s/u.test(value[cursor] ?? "") && cursor < value.length - 1) cursor++;
    if (cursor === value.length - 1 && result.length === 0) return [];
    let item = "",
      quoted = false,
      escaped = false;
    if (value[cursor] === '"') {
      quoted = true;
      cursor++;
      let closed = false;
      while (cursor < value.length - 1) {
        const character = value[cursor++];
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === "\\") {
          if (cursor >= value.length - 1) throw new TypeError("Invalid PostgreSQL catalog escape");
          item += value[cursor++];
        } else item += character;
      }
      if (!closed) throw new TypeError("Unclosed PostgreSQL catalog array item");
      while (/\s/u.test(value[cursor] ?? "") && cursor < value.length - 1) cursor++;
    } else {
      let significant = 0;
      while (cursor < value.length - 1 && value[cursor] !== ",") {
        const character = value[cursor++];
        if ('{}"'.includes(character)) throw new TypeError("Unsupported PostgreSQL catalog array item");
        if (character === "\\") {
          if (cursor >= value.length - 1) throw new TypeError("Invalid PostgreSQL catalog escape");
          item += value[cursor++];
          escaped = true;
          significant = item.length;
        } else {
          item += character;
          if (!/\s/u.test(character)) significant = item.length;
        }
      }
      item = item.slice(0, significant);
      if (!item) throw new TypeError("Empty unquoted PostgreSQL catalog item");
    }
    result.push(!quoted && !escaped && item === "NULL" ? null : item);
    if (cursor === value.length - 1) break;
    if (value[cursor++] !== "," || cursor === value.length - 1)
      throw new TypeError("Invalid PostgreSQL catalog separator");
  }
  return result;
}

const boolean = (value) => {
  if (value !== "t" && value !== "f") throw new TypeError("Unknown PostgreSQL catalog boolean");
  return value === "t";
};
const ordinal = (value) => {
  if (!/^\d+$/u.test(String(value)) || !Number.isSafeInteger(Number(value)))
    throw new TypeError("Invalid PostgreSQL catalog count");
  return Number(value);
};
const member = (value, allowed, label) => {
  if (!allowed.includes(value)) throw new TypeError(`Unknown PostgreSQL ${label}: ${value}`);
  return value;
};

/** Canonical spellings come from independent native type metadata, never a host parser. */
export function canonicalTypes(rows) {
  const result = new Map();
  for (const row of rows) {
    if (typeof row.name !== "string" || typeof row.canonical_name !== "string")
      throw new TypeError("Missing native PostgreSQL type spelling");
    if (result.has(row.name) && result.get(row.name) !== row.canonical_name)
      throw new TypeError("Ambiguous native PostgreSQL type spelling");
    result.set(row.name, row.canonical_name);
  }
  return result;
}

/** Reconstruct catalog descriptors from source fields, with type labels supplied independently. */
export function sourceRoutineRow(row, typeNames, keywords) {
  const type = (name) => {
    const value = typeNames.get(name);
    if (!value) throw new TypeError(`Missing PostgreSQL canonical type label: ${name}`);
    return value;
  };
  if (typeof row.proname !== "string" || typeof row.pronamespace !== "string" || typeof row.proargtypes !== "string")
    throw new TypeError("Missing PostgreSQL source routine identity");
  const inputs = row.proargtypes.trim() ? row.proargtypes.trim().split(/\s+/u).map(type) : [];
  const all = catalogArray(row.proallargtypes)?.map(type) ?? inputs;
  const modes = catalogArray(row.proargmodes);
  const names = catalogArray(row.proargnames);
  if ((modes && modes.length !== all.length) || (names && names.length !== all.length))
    throw new TypeError("PostgreSQL source formal vector lengths differ");
  const effectiveModes = modes ?? all.map(() => "i");
  for (const mode of effectiveModes) member(mode, ["i", "o", "b", "v", "t"], "parameter mode");
  const inputModes = effectiveModes.filter((mode) => ["i", "b", "v"].includes(mode));
  if (inputModes.length !== inputs.length || ordinal(row.pronargs) !== inputs.length)
    throw new TypeError("PostgreSQL source input count differs");
  // PostgreSQL bootstrap expands text-array constants and replaces pronargdefaults.
  const bootstrapDefaults = catalogArray(row.proargdefaults);
  const defaults = bootstrapDefaults?.length ?? ordinal(row.pronargdefaults);
  if (defaults > inputs.length) throw new TypeError("PostgreSQL source default count exceeds inputs");
  const variadic = row.provariadic !== "0";
  if (effectiveModes.filter((mode) => mode === "v").length !== Number(variadic))
    throw new TypeError("PostgreSQL source variadic modes differ");
  const kind = member(row.prokind, ["f", "a", "w", "p"], "routine kind");
  const returnsSet = boolean(row.proretset);
  const quote = (name) =>
    /^[a-z_][a-z_0-9]*$/u.test(name) &&
    !keywords.some((word) => word.name === name && word.category !== "UNRESERVED_KEYWORD")
      ? name
      : `"${name.replaceAll('"', '""')}"`;
  const result =
    kind === "p"
      ? null
      : effectiveModes.includes("t")
        ? `TABLE(${effectiveModes.flatMap((mode, index) => (mode === "t" ? [`${quote(names?.[index] ?? "")} ${all[index]}`] : [])).join(", ")})`
        : `${returnsSet ? "SETOF " : ""}${type(row.prorettype)}`;
  return {
    name: row.proname,
    namespace: row.pronamespace,
    kind,
    identity: `${row.pronamespace}.${row.proname}(${inputs.join(", ")})`,
    argument_types: inputs,
    all_argument_types: all,
    parameter_modes: modes,
    parameter_names: names,
    input_count: inputs.length,
    defaults,
    bootstrap_default_constants: bootstrapDefaults,
    default_expressions_sql: null,
    variadic,
    variadic_type: variadic ? type(row.provariadic) : null,
    result,
    returns_set: returnsSet,
    strict: boolean(row.proisstrict),
    volatility: member(row.provolatile, ["i", "s", "v"], "volatility"),
    parallel: member(row.proparallel, ["s", "r", "u"], "parallel mode"),
  };
}

/** Source descriptors use the same executable routine schema as native observations. */
export function sourceRoutine(row, typeNames, keywords, header) {
  const descriptor = applyHeader(sourceRoutineRow(row, typeNames, keywords), header);
  const mapper = {
    ...postgresMapper,
    routineFacts: (row) => {
      const facts = postgresMapper.routineFacts(row);
      return {
        ...facts,
        parameters: facts.parameters.map((parameter, index) => ({
          ...parameter,
          ...(header?.parameters[index]?.default === null || header?.parameters[index]?.default === undefined
            ? {}
            : { defaultExpression: header.parameters[index].default }),
        })),
      };
    },
  };
  return parseRoutine(describeRoutine(routineSignature(mapper, descriptor), mapper));
}

export const routineKey = (row) => JSON.stringify([row.namespace, row.name, row.kind, row.argument_types]);
const headerKey = (header) => JSON.stringify([header.namespace, header.name, header.inputs]);

export function sourceHeaders(facts, source, typeNames) {
  const path = "src/backend/catalog/system_functions.sql",
    digest = source.textInputs[path];
  if (!digest || !facts.texts[digest]) throw new TypeError("Missing PostgreSQL installation SQL input");
  const grammar = facts.texts[source.textInputs["src/backend/parser/gram.y"]];
  if (!grammar) throw new TypeError("Missing PostgreSQL grammar source input");
  const aliases = grammarTypeAliases(grammar, source.keywords, typeNames);
  const result = installationHeaders(facts.texts[digest], new Map([...typeNames, ...aliases]));
  const headers = new Map();
  for (const header of result.headers) {
    const key = headerKey(header);
    if (headers.has(key)) throw new TypeError("Multiple PostgreSQL installation headers for one routine");
    headers.set(key, { ...header, source: path, digest });
  }
  return { headers, gaps: result.gaps };
}

export function applyHeader(row, header) {
  if (!header) return row;
  const all = header.parameters.map(({ type }) => type),
    modes = header.parameters.map(({ mode }) => mode);
  if (headerKey(header) !== JSON.stringify([row.namespace, row.name, row.argument_types]))
    throw new TypeError("PostgreSQL installation header identity differs");
  return {
    ...row,
    all_argument_types: all,
    parameter_modes: modes.some((mode) => mode !== "i") ? modes : null,
    parameter_names: header.parameters.some(({ name }) => name !== null)
      ? header.parameters.map(({ name }) => name ?? "")
      : null,
    defaults: header.defaults,
    default_expressions_sql: header.defaults
      ? header.parameters
          .filter(({ default: value }) => value !== null)
          .map(({ default: value }) => value)
          .join(", ")
      : null,
  };
}

/** Equality here qualifies descriptor fields only, not execution, nullability or decoding. */
export function compareRoutines(facts, source, capture) {
  const types = canonicalTypes(capture.categories.types.rows);
  const installation = sourceHeaders(facts, source, types);
  const native = new Map();
  for (const row of capture.categories.functions.rows) {
    const key = routineKey(row);
    if (native.has(key)) throw new TypeError("Duplicate native PostgreSQL routine key");
    native.set(key, row);
  }
  const matched = [],
    sourceOnly = [],
    mismatches = [];
  for (const { row: id } of source.catalogs.pg_proc.entries) {
    const original = sourceRoutineRow(facts.rows[id], types, source.keywords);
    const header = installation.headers.get(
      JSON.stringify([original.namespace, original.name, original.argument_types]),
    );
    const row = applyHeader(original, header),
      actual = native.get(routineKey(row));
    if (!actual) {
      sourceOnly.push({ sourceRow: id, identity: row.identity });
      continue;
    }
    native.delete(routineKey(row));
    const fields = [
      "all_argument_types",
      "parameter_modes",
      "parameter_names",
      "input_count",
      "defaults",
      "variadic",
      "variadic_type",
      "result",
      "returns_set",
      "strict",
      "volatility",
      "parallel",
    ];
    const differences = fields.filter((field) => JSON.stringify(row[field]) !== JSON.stringify(actual[field]));
    if (differences.length)
      mismatches.push({ sourceRow: id, identity: row.identity, fields: differences, expected: row, actual });
    else matched.push({ sourceRow: id, identity: row.identity });
  }
  return {
    qualification:
      "catalog descriptors with installation parameter overlays; canonical type spellings come from native type metadata; canonical default rendering, execution, nullability and decoding unqualified",
    installationHeaders: installation.headers.size,
    installationGaps: installation.gaps,
    matched,
    sourceOnly,
    nativeOnly: [...native.values()].map(({ identity }) => identity).sort(),
    mismatches,
  };
}

/** Only source records whose final descriptors agree with native observations may drive emission. */
export function prepareSourceProfile(facts, source, capture) {
  const comparison = compareRoutines(facts, source, capture);
  if (comparison.sourceOnly.length || comparison.mismatches.length || comparison.installationGaps.length)
    throw new TypeError(`Unqualified PostgreSQL source routine projection: ${capture.target.version}`);
  const types = canonicalTypes(capture.categories.types.rows);
  const installation = sourceHeaders(facts, source, types);
  const headers = new Map(
    [...installation.headers.values()].map((header) => [
      `${header.namespace}.${header.name}(${header.inputs.join(", ")})`,
      header,
    ]),
  );
  const routines = new Map();
  for (const { sourceRow, identity } of comparison.matched) {
    const routine = sourceRoutine(facts.rows[sourceRow], types, source.keywords, headers.get(identity));
    if (routine.identity !== identity || routines.has(identity))
      throw new TypeError("PostgreSQL source projection identity differs");
    routines.set(identity, routine);
  }
  return { comparison, routines };
}
