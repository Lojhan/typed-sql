import { numericVersionBand } from "../registry.mjs";

const numericFields = Object.freeze({ functions: ["arity", "builtin", "flags"], collations: ["seq"] });

export const sqliteMapper = Object.freeze({
  id: "sqlite",
  versionBand: numericVersionBand(3),
  normalizeRow(category, row) {
    const normalized = { ...row };
    for (const field of numericFields[category] ?? []) {
      const value = row[field];
      if (value === undefined) continue;
      if (
        (typeof value !== "number" && !(typeof value === "string" && /^-?\d+$/u.test(value))) ||
        !Number.isSafeInteger(Number(value))
      )
        throw new TypeError(`Invalid SQLite native integer: ${field}`);
      normalized[field] = Number(value);
    }
    return normalized;
  },
  routineFacts(row) {
    const parameters =
      Number(row.arity) >= 0 && row.arity !== undefined
        ? Array.from({ length: Number(row.arity) }, (_, index) => ({
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
      variadic: row.arity === undefined ? null : Number(row.arity) === -1,
    };
  },
});
