import { identityFields, numericVersionBand } from "../registry.mjs";
import { sqlserverEntityFacts } from "./facets/sqlserver.mjs";

export const sqlServerMapper = Object.freeze({
  id: "sqlserver",
  entityFacts: sqlserverEntityFacts,
  versionBand: numericVersionBand(1),
  reviewTarget(target) {
    if (!target.settings) return target;
    const { databaseName: _disposableDatabaseName, ...settings } = target.settings;
    return { ...target, settings };
  },
  normalizeRow: (_category, row) => row,
  parameterMode: (mode) => (mode === "input" ? "input" : "unknown"),
  resultColumn: (column) => ({
    name: column.name,
    nativeType: column.type_name ?? null,
    nullable:
      typeof column.is_nullable === "boolean"
        ? column.is_nullable
        : column.is_nullable === 0
          ? false
          : column.is_nullable === 1
            ? true
            : null,
  }),
  entityIdentity: identityFields({ keywords: ["name"], types: ["name"], collations: ["name"], settings: ["name"] }),
  routineFacts(row) {
    const returnsSet = row.kind === undefined ? null : ["IF", "TF", "FT"].includes(row.kind);
    if (row.parameters_json == null) return { returnsSet };
    const native = typeof row.parameters_json === "string" ? JSON.parse(row.parameters_json) : row.parameters_json;
    if (!Array.isArray(native)) throw new TypeError(`Invalid SQL Server parameter facts: ${row.name}`);
    const resultMetadata = native.find((parameter) => Number(parameter.position) === 0) ?? null;
    const resultColumns =
      row.return_columns_json == null
        ? null
        : typeof row.return_columns_json === "string"
          ? JSON.parse(row.return_columns_json)
          : row.return_columns_json;
    if (resultColumns !== null && !Array.isArray(resultColumns))
      throw new TypeError(`Invalid SQL Server return-column facts: ${row.name}`);
    return {
      parameters: native
        .filter((parameter) => Number(parameter.position) !== 0)
        .map((parameter) => ({
          ...parameter,
          inputPosition: Number(parameter.position),
          nativeType: parameter.type_name,
          mode: parameter.is_output ? "output-flagged" : "input",
          variadic: false,
          hasDefault: parameter.has_default_value ? true : ["FS", "FT", "AF"].includes(row.kind) ? false : null,
        })),
      resultMetadata,
      result: resultMetadata?.type_name ?? null,
      resultColumns,
      returnsSet,
      defaultsKnowledge: "catalog-metadata; TSQL defaults may be unavailable",
    };
  },
});
