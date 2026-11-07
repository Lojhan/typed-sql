import { numericVersionBand } from "../registry.mjs";

export const postgresMapper = Object.freeze({
  id: "postgres",
  versionBand: numericVersionBand(1),
  normalizeRow: (_category, row) => row,
  routineFacts(row) {
    if (!Array.isArray(row.all_argument_types ?? row.argument_types)) return {};
    if (row.parameter_modes != null && !Array.isArray(row.parameter_modes))
      throw new TypeError(`Invalid PostgreSQL parameter modes: ${row.name}`);
    const types = row.all_argument_types ?? row.argument_types;
    let inputPosition = 0;
    const inputCount = Number(row.input_count ?? row.argument_types.length),
      defaults = Number(row.defaults);
    const parameters = types.map((type, index) => {
      const mode = row.parameter_modes?.[index] ?? "i",
        input = ["i", "b", "v"].includes(mode);
      if (input) inputPosition++;
      return {
        position: index + 1,
        inputPosition: input ? inputPosition : null,
        name: row.parameter_names?.[index] || null,
        nativeType: type,
        mode,
        variadic: mode === "v",
        hasDefault: input ? (Number.isInteger(defaults) ? inputPosition > inputCount - defaults : null) : false,
      };
    });
    return {
      parameters,
      resultColumns: parameters
        .filter((parameter) => ["o", "b", "t"].includes(parameter.mode))
        .map((parameter) => ({ name: parameter.name, nativeType: parameter.nativeType, nullable: null })),
      defaultExpressions: row.default_expressions_sql ?? null,
      defaultsKnowledge: "catalog-count-and-native-sql-list",
    };
  },
});
