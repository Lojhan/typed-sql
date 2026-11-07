import { createMapperRegistry } from "../../../tools/grammar-catalog/src/registry.mjs";
export function createDiscoveryRegistry(definitions) {
  return createMapperRegistry(definitions, {
    methods: [
      "versionBand",
      "routineFacts",
      "normalizeRow",
      "discoveryQueries",
      "discoveryRow",
      "discoveryScope",
      "discoveryLimitation",
      "discoveryDerived",
    ],
  });
}
