import { identityFields, numericVersionBand } from "../registry.mjs";

export const mysqlMapper = Object.freeze({
  id: "mysql",
  versionBand: numericVersionBand(2),
  normalizeRow: (_category, row) => row,
  entityIdentity: identityFields({
    keywords: ["name"],
    types: ["name"],
    collations: ["name"],
    settings: ["name"],
    syntax: ["name"],
  }),
  routineFacts: () => ({}),
});
