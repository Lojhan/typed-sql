import { declaredType, headerTokens, installationHeaders } from "./sql-headers.mjs";

const word = (token, value) => token?.kind === "word" && token.value === value;

/** Explicit schema declarations are required; implicit search_path guesses cannot qualify metadata. */
export function moduleNamespace(sql, control) {
  const tokens = headerTokens(sql);
  const namespaces = [];
  for (let index = 0; index < tokens.length; index++) {
    if (!word(tokens[index], "set") || !word(tokens[index + 1], "search_path")) continue;
    if (
      !(tokens[index + 2]?.value === "=" || word(tokens[index + 2], "to")) ||
      !["word", "quoted"].includes(tokens[index + 3]?.kind) ||
      tokens[index + 4]?.value !== ";"
    )
      throw new TypeError("Unqualified installation search_path");
    namespaces.push(tokens[index + 3].value);
  }
  if (control !== undefined) {
    const declarations = control.split(/\r?\n/u).filter((line) => /^\s*schema\s*=/u.test(line));
    for (const line of declarations) {
      const match = /^\s*schema\s*=\s*(?:'((?:[^']|'')*)'|([a-z_][a-z_0-9]*))\s*(?:#.*)?$/u.exec(line);
      if (!match) throw new TypeError("Unqualified extension control schema");
      namespaces.push(match[1]?.replaceAll("''", "'") ?? match[2]);
    }
  }
  if (new Set(namespaces).size > 1) throw new TypeError("Conflicting installation namespaces");
  return namespaces[0] ?? null;
}

function descriptor(tokens, header, typeNames) {
  if (typeof header.namespace !== "string" || !header.namespace)
    throw new TypeError("Installation routine namespace is unavailable");
  if (header.parameters.some(({ mode }) => mode !== "i"))
    throw new TypeError("Unqualified non-input installation parameter mode");
  let cursor = tokens.findIndex((token) => token.start >= header.end);
  if (cursor < 0 || !word(tokens[cursor++], "returns"))
    throw new TypeError("Missing installed routine return declaration");
  const returnsSet = word(tokens[cursor], "setof");
  if (returnsSet) cursor++;
  const start = cursor;
  const attributes = new Set([
    "language",
    "as",
    "strict",
    "called",
    "returns",
    "immutable",
    "stable",
    "volatile",
    "parallel",
    "window",
    "security",
    "external",
    "cost",
    "rows",
    "set",
    "support",
    "transform",
    "leakproof",
    "not",
    "return",
    "begin",
  ]);
  while (
    cursor < tokens.length &&
    !(tokens[cursor].kind === "word" && attributes.has(tokens[cursor].value)) &&
    tokens[cursor].value !== ";"
  )
    cursor++;
  const result = declaredType(tokens.slice(start, cursor), typeNames);
  if (!result) throw new TypeError("Unqualified installed routine result type");
  const properties = { strict: false, volatility: "v", parallel: "u", kind: "f", language: null };
  const seen = new Set();
  function set(name, value) {
    if (seen.has(name)) throw new TypeError(`Duplicate installed routine attribute: ${name}`);
    seen.add(name);
    properties[name] = value;
  }
  while (cursor < tokens.length && tokens[cursor].value !== ";") {
    const token = tokens[cursor++];
    if (word(token, "language")) {
      const language = tokens[cursor++];
      if (!["word", "quoted", "string"].includes(language?.kind) || !["c", "internal"].includes(language.value))
        throw new TypeError("Unqualified installed routine implementation language");
      set("language", language.value);
    } else if (word(token, "as")) {
      if (seen.has("body") || tokens[cursor++]?.kind !== "string")
        throw new TypeError("Unqualified installed routine external body");
      seen.add("body");
      if (tokens[cursor]?.value === ",") {
        cursor++;
        if (tokens[cursor++]?.kind !== "string") throw new TypeError("Unqualified installed routine external symbol");
      }
    } else if (word(token, "strict")) set("strict", true);
    else if (word(token, "called") || word(token, "returns")) {
      const sequence = word(token, "called") ? ["on", "null", "input"] : ["null", "on", "null", "input"];
      for (const value of sequence)
        if (!word(tokens[cursor++], value)) throw new TypeError("Unqualified installed routine null-input clause");
      set("strict", word(token, "returns"));
    } else if (token.kind === "word" && ["immutable", "stable", "volatile"].includes(token.value))
      set("volatility", { immutable: "i", stable: "s", volatile: "v" }[token.value]);
    else if (word(token, "parallel")) {
      const mode = tokens[cursor++];
      if (mode?.kind !== "word" || !["unsafe", "restricted", "safe"].includes(mode.value))
        throw new TypeError("Unqualified installed routine parallel clause");
      set("parallel", { unsafe: "u", restricted: "r", safe: "s" }[mode.value]);
    } else if (word(token, "window")) set("kind", "w");
    else throw new TypeError(`Unqualified installed routine attribute: ${token.value}`);
  }
  if (!properties.language || !seen.has("body"))
    throw new TypeError("Incomplete installed routine implementation metadata");
  return {
    name: header.name,
    namespace: header.namespace,
    kind: properties.kind,
    identity: `${header.namespace}.${header.name}(${header.inputs.join(", ")})`,
    argument_types: header.inputs,
    all_argument_types: header.inputs,
    parameter_modes: null,
    parameter_names: header.parameters.some(({ name }) => name !== null)
      ? header.parameters.map(({ name }) => name ?? "")
      : null,
    input_count: header.inputs.length,
    defaults: header.defaults,
    default_expressions_sql: header.defaults
      ? header.parameters
          .filter(({ default: value }) => value !== null)
          .map(({ default: value }) => value)
          .join(", ")
      : null,
    variadic: false,
    variadic_type: null,
    result: `${returnsSet ? "SETOF " : ""}${result}`,
    returns_set: returnsSet,
    strict: properties.strict,
    volatility: properties.volatility,
    parallel: properties.parallel,
  };
}

/** Qualify a bounded external-function declaration surface; unknown clauses remain explicit gaps. */
export function installedRoutineDescriptors(sql, typeNames, control) {
  const namespace = moduleNamespace(sql, control);
  const parsed = installationHeaders(sql, typeNames, { namespace });
  const tokens = headerTokens(sql),
    rows = [],
    gaps = [...parsed.gaps];
  for (const header of parsed.headers) {
    try {
      rows.push({ header, row: descriptor(tokens, header, typeNames) });
    } catch (error) {
      gaps.push({ start: header.start, reason: String(error) });
    }
  }
  return { rows, gaps };
}
