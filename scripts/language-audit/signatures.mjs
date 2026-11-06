import { hash } from "./hash.mjs";

// Engine facts only. No TypeScript mappings, guessed coercions, or optimistic nullability.
// A future catalog generator consumes these signatures plus grammar-owned policy overrides.
export function signatureFacts(dialect, row) {
  const namespace = row.namespace ?? row.schema_name ?? null;
  let parameters = null;
  let result = row.result ?? null;
  let defaultExpressions = null;
  let resultMetadata = null;
  let resultColumns = null;
  let defaultsKnowledge = "unavailable";
  if (dialect === "postgres" && Array.isArray(row.all_argument_types ?? row.argument_types)) {
    const types = row.all_argument_types ?? row.argument_types;
    let inputPosition = 0;
    const inputCount = Number(row.input_count ?? row.argument_types.length);
    const defaults = Number(row.defaults);
    if (row.parameter_modes != null && !Array.isArray(row.parameter_modes))
      throw new Error(`Invalid PostgreSQL parameter modes: ${row.name}`);
    parameters = types.map((type, index) => {
      const mode = row.parameter_modes?.[index] ?? "i";
      const input = ["i", "b", "v"].includes(mode);
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
    resultColumns = parameters
      .filter((parameter) => ["o", "b", "t"].includes(parameter.mode))
      .map((parameter) => ({ name: parameter.name, nativeType: parameter.nativeType, nullable: null }));
    defaultExpressions = row.default_expressions_sql ?? null;
    defaultsKnowledge = "catalog-count-and-native-sql-list";
  } else if (dialect === "duckdb" && Array.isArray(row.arguments)) {
    parameters = row.arguments.map((type, index) => ({
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
  } else if (dialect === "sqlserver" && row.parameters_json != null) {
    const native = typeof row.parameters_json === "string" ? JSON.parse(row.parameters_json) : row.parameters_json;
    if (!Array.isArray(native))
      throw new Error(`Invalid SQL Server parameter facts: ${row.name}: ${JSON.stringify(native).slice(0, 160)}`);
    parameters = native
      .filter((parameter) => Number(parameter.position) !== 0)
      .map((parameter) => ({
        ...parameter,
        inputPosition: Number(parameter.position),
        nativeType: parameter.type_name,
        mode: parameter.is_output ? "output-flagged" : "input",
        variadic: false,
        hasDefault: parameter.has_default_value ? true : ["FS", "FT", "AF"].includes(row.kind) ? false : null,
      }));
    resultMetadata = native.find((parameter) => Number(parameter.position) === 0) ?? null;
    result = resultMetadata?.type_name ?? null;
    if (row.return_columns_json != null) {
      resultColumns =
        typeof row.return_columns_json === "string" ? JSON.parse(row.return_columns_json) : row.return_columns_json;
      if (!Array.isArray(resultColumns)) throw new Error(`Invalid SQL Server return-column facts: ${row.name}`);
    }
    defaultsKnowledge = "catalog-metadata; TSQL defaults may be unavailable";
  } else if (dialect === "sqlite" && Number(row.arity) >= 0 && row.arity !== undefined) {
    parameters = Array.from({ length: Number(row.arity) }, (_, index) => ({
      position: index + 1,
      inputPosition: index + 1,
      name: null,
      nativeType: null,
      mode: "positional",
      variadic: false,
      hasDefault: null,
    }));
  }
  const registration = dialect === "sqlite" && row.arity !== undefined;
  const identity =
    row.identity ??
    (parameters === null && !registration
      ? `${namespace ?? ""}.${row.name}/name-only`
      : `${namespace ?? ""}.${row.name}/${row.kind ?? "unknown"}/${hash({ parameters: parameters?.map((parameter) => ({ type: parameter.nativeType, mode: parameter.mode, position: parameter.inputPosition, ...(parameter.mode === "named" ? { name: parameter.name } : {}) })) ?? null, variadic: row.variadic ?? row.varargs ?? Number(row.arity) === -1, arity: row.arity ?? null, encoding: row.encoding ?? null })}`);
  return {
    formatVersion: 1,
    name: row.name,
    kind: row.kind ?? null,
    identity,
    identityKnowledge: registration
      ? "catalog-registration"
      : parameters === null
        ? "name-only"
        : ["macro", "table_macro"].includes(row.kind)
          ? "catalog-shape; optional/default parameters unverified"
          : "catalog-signature",
    namespace,
    parameters,
    parameterKnowledge:
      parameters === null ? "unavailable" : dialect === "sqlite" ? "arity-only; dynamic argument types" : "catalog",
    defaultExpressions,
    defaultsKnowledge,
    variadic:
      row.variadic ??
      (row.varargs != null
        ? true
        : dialect === "sqlite"
          ? row.arity === undefined
            ? null
            : Number(row.arity) === -1
          : parameters === null
            ? null
            : false),
    variadicNativeType: row.variadic_type ?? row.varargs ?? null,
    result: {
      nativeType: result,
      nativeMetadata: resultMetadata,
      typeKnowledge:
        result === null ? (dialect === "sqlite" ? "dynamic-or-unavailable" : "unavailable") : "catalog-native-type",
      columns: resultColumns,
      returnsSet:
        row.returns_set ??
        (row.kind === undefined ? null : ["table", "table_macro", "IF", "TF", "FT"].includes(row.kind)),
      nullable: null,
      nullabilityKnowledge: "unverified",
    },
    properties: {
      strict: row.strict ?? null,
      volatility: row.volatility ?? row.stability ?? null,
      sideEffects: row.side_effects ?? null,
      parallel: row.parallel ?? null,
      deterministic: row.deterministic ?? null,
      nativeFlags: row.flags ?? null,
      aliasOf: row.alias_of ?? null,
      macroDefinition: row.macro_definition ?? null,
    },
    policyRequired: [
      "coercions",
      "polymorphism",
      "result-nullability",
      "decoding",
      "special-syntax",
      "version-availability-between-captures",
    ],
  };
}
