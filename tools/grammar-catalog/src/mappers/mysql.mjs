import { numericVersionBand } from "../registry.mjs";

export const mysqlMapper = Object.freeze({
  id: "mysql",
  versionBand: numericVersionBand(2),
  normalizeRow: (_category, row) => row,
  routineFacts: () => ({}),
});
