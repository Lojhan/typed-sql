const missing = (field) => ({ status: "unknown", reason: `Native ${field} evidence unavailable` });
export const facetKinds = Object.freeze({
  functions: "routine",
  keywords: "keyword",
  types: "type",
  operators: "operator",
  casts: "cast",
  collations: "collation",
  settings: "setting",
  extensions: "extension",
  syntax: "syntax",
});
export const nativeType = (value) =>
  typeof value === "string" && value.trim()
    ? { kind: "native", identity: value }
    : { kind: "unknown", reason: "Native type evidence unavailable" };
export function field(row, name, kind = "text") {
  const value = row[name];
  if (value === null || value === undefined) return missing(name);
  if (kind === "text" && typeof value === "string" && value.trim()) return { status: "known", value };
  if (kind === "boolean" && [true, false, 0, 1, "0", "1"].includes(value))
    return { status: "known", value: value === true || value === 1 || value === "1" };
  if (
    kind === "integer" &&
    (typeof value === "number" || (typeof value === "string" && /^-?\d+$/u.test(value))) &&
    Number.isSafeInteger(Number(value))
  )
    return { status: "known", value: Number(value) };
  if (kind === "texts" && Array.isArray(value) && value.every((item) => typeof item === "string"))
    return { status: "known", value };
  throw new TypeError(`Invalid native ${kind} field: ${name}`);
}
export const known = (value) => ({ status: "known", value });
export const mapped = (row, name, values) =>
  Object.hasOwn(values, row[name]) ? known(values[row[name]]) : missing(name);
export function castEndpoints(row) {
  const parts = row.name.split(" -> ");
  return parts.length === 2 ? { from: nativeType(parts[0]), to: nativeType(parts[1]) } : {};
}

/** Every standard facet is explicit, including facts the capture cannot establish. */
export function describeEntity(category, name, facts = {}) {
  const unknownType = nativeType(undefined);
  const defaults = {
    functions: { kind: "routine" },
    keywords: {
      kind: "keyword",
      spelling: name,
      reserved: missing("reserved-word role"),
      nativeCategory: missing("keyword category"),
    },
    types: {
      kind: "type",
      canonical: unknownType,
      nativeKind: missing("type kind"),
      category: missing("type category"),
      defined: missing("type definition"),
      preferred: missing("preferred type"),
      storageIdentity: missing("physical storage identity"),
      dimensions: { maxLength: missing("maximum length"), precision: missing("precision"), scale: missing("scale") },
    },
    operators: {
      kind: "operator",
      operands: missing("operand types"),
      result: unknownType,
      fixity: missing("operator fixity"),
    },
    casts: {
      kind: "cast",
      from: unknownType,
      to: unknownType,
      context: missing("cast context"),
      method: missing("cast method"),
    },
    collations: {
      kind: "collation",
      provider: missing("collation provider"),
      encoding: missing("collation encoding"),
      characterSet: missing("collation character set"),
      isDefault: missing("default collation"),
    },
    settings: {
      kind: "setting",
      valueType: missing("setting value type"),
      context: missing("setting context"),
      scope: missing("setting scope"),
      enumValues: missing("setting enum values"),
      minimum: missing("setting minimum"),
      maximum: missing("setting maximum"),
      dynamic: missing("dynamic setting"),
    },
    extensions: {
      kind: "extension",
      defaultVersion: missing("extension default version"),
      installed: missing("extension installation"),
    },
    syntax: { kind: "syntax", production: missing("syntax production") },
  };
  return {
    ...(defaults[category] ?? { kind: "unknown", reason: "No standard semantic facet for this category" }),
    ...facts,
  };
}
