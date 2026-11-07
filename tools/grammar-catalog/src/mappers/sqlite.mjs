import { identityFields, numericVersionBand } from "../registry.mjs";

const numericFields = Object.freeze({ functions: ["arity", "builtin", "flags"], collations: ["seq"] });

function registrationArity(row) {
  if (row.arity === undefined) return undefined;
  if (
    typeof row.arity !== "number" &&
    typeof row.arity !== "bigint" &&
    !(typeof row.arity === "string" && /^-?\d+$/u.test(row.arity))
  )
    throw new TypeError("Invalid SQLite registration arity");
  const arity = Number(row.arity);
  // SQLite's registered sentinels are -1 (variadic), -3 (one or more), -4 (two or more).
  // -2 is a lookup request, not a function definition. The native hard limit is 32767.
  if (!Number.isSafeInteger(arity) || arity < -4 || arity === -2 || arity > 32767)
    throw new TypeError("Invalid SQLite registration arity");
  return arity;
}

export const sqliteMapper = Object.freeze({
  id: "sqlite",
  namespacePolicy: "global",
  entityFacts: (category, row) => (category === "keywords" ? { spelling: row.name.toUpperCase() } : {}),
  versionBand: numericVersionBand(3),
  parameterMode: (mode) => (mode === "positional" ? "input" : "unknown"),
  entityIdentity: identityFields({ keywords: ["name"], types: ["name"], collations: ["name"], settings: ["name"] }),
  normalizeRow(category, row) {
    const normalized = { ...row };
    for (const field of numericFields[category] ?? []) {
      const value = row[field];
      if (value === undefined) continue;
      if (
        (typeof value !== "number" &&
          typeof value !== "bigint" &&
          !(typeof value === "string" && /^-?\d+$/u.test(value))) ||
        !Number.isSafeInteger(Number(value))
      )
        throw new TypeError(`Invalid SQLite native integer: ${field}`);
      normalized[field] = Number(value);
    }
    if (category === "functions") registrationArity(normalized);
    return normalized;
  },
  routineFacts(row) {
    const arity = registrationArity(row);
    const parameters =
      arity !== undefined && arity >= 0
        ? Array.from({ length: arity }, (_, index) => ({
            position: index + 1,
            inputPosition: index + 1,
            name: null,
            nativeType: null,
            mode: "positional",
            variadic: false,
            hasDefault: null,
          }))
        : null;
    return {
      parameters,
      registration: row.arity !== undefined,
      parameterKnowledge: "arity-only; dynamic argument types",
      unknownResultKnowledge: "dynamic-or-unavailable",
      variadic: arity === undefined ? null : arity < 0,
    };
  },
});
