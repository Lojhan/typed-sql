import { canonical } from "../../../tools/grammar-catalog/src/model/canonical.mjs";
import type { NativeDescriptionMapper } from "./contracts.js";

export const duckDBDescription: NativeDescriptionMapper = {
  id: "duckdb",
  claimSql: (type) => `SELECT CAST(NULL AS ${type}) AS value`,
  identity: (descriptor) => {
    if (
      !Number.isInteger(descriptor.engineType) ||
      !descriptor.nativeType ||
      !descriptor.nativeTypeStructure ||
      typeof descriptor.nativeTypeStructure !== "object"
    )
      return undefined;
    // Keep aliases/branding as well as nested logical type structure from the driver.
    return JSON.stringify(canonical([descriptor.engineType, descriptor.nativeType, descriptor.nativeTypeStructure]));
  },
};
