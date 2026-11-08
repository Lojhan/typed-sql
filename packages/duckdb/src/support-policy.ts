/** Pure target declarations shared by grammar support and test/CI discovery. */
export const DUCKDB_SUPPORT_POLICY = Object.freeze({
  qualifiedEngines: Object.freeze(["1.5.6", "2.0.0"] as const),
  nodeApi: Object.freeze({ "1.5.6": "1.5.6-r.2", "2.0.0": "2.0.0-r.1" }),
  unknownNewer: "conservative",
  minimum: "1.5.6",
} as const);
