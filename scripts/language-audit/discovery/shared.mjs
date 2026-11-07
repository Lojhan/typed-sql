const LIMITATIONS = {
  functions:
    "No complete native-function enumeration in this engine; use the independent official reference inventory. SQL Server system objects omit parser built-ins.",
  keywords:
    "No SQL metadata query enumerates keywords; use the official keyword reference (SQLite also exposes a C API).",
  types:
    "No complete named-type enumeration through SQL metadata. SQLite accepts arbitrary declared types and uses affinities; use the official type reference.",
  operators: "No complete operator enumeration through SQL metadata; use the official operator reference.",
  casts: "No complete cast enumeration through SQL metadata; contextual coercions require generated behavioral probes.",
  collations: "No complete collation enumeration through SQL metadata.",
  settings: "No complete setting enumeration through SQL metadata.",
  extensions: "No complete extension enumeration through SQL metadata; installed functions are captured separately.",
  syntax:
    "Catalogs cannot enumerate SQL productions. Official statement/reference inventories and behavioral conformance probes are required.",
};

export const legacyDiscoveryDefaults = {
  discoveryRow: (_category, row) => row,
  discoveryScope: () => "engine",
  discoveryLimitation: (category) => LIMITATIONS[category],
  discoveryDerived: async () => {},
};
