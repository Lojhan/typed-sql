import { numericVersionBand } from "../registry.mjs";

export const duckdbMapper = Object.freeze({
  id: "duckdb",
  versionBand: numericVersionBand(3),
  normalizeRow: (_category, row) => row,
  routineFacts(row) {
    const shape = {
      returnsSet: row.kind === undefined ? null : ["table", "table_macro"].includes(row.kind),
      identityKnowledge: ["macro", "table_macro"].includes(row.kind)
        ? "catalog-shape; optional/default parameters unverified"
        : "catalog-signature",
    };
    if (!Array.isArray(row.arguments)) return shape;
    const parameters = row.arguments.map((type, index) => ({
      position: index + 1,
      inputPosition: index + 1,
      name: row.parameter_names?.[index] ?? null,
      nativeType: type,
      mode: "positional",
      variadic: false,
      hasDefault: null,
    }));
    for (const [name, type] of Object.entries(row.named_arguments ?? {}))
      parameters.push({
        position: null,
        inputPosition: null,
        name,
        nativeType: type,
        mode: "named",
        variadic: false,
        hasDefault: null,
      });
    return { ...shape, parameters };
  },
});
