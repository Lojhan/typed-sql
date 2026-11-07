import type { NativeDescriptionMapper } from "./contracts.js";

export const sqlServerDescription: NativeDescriptionMapper = {
  id: "sqlserver",
  claimSql: (type) => `SELECT CAST(NULL AS ${type}) AS value`,
  identity: (descriptor) => {
    // system_type_id alone is physical storage, not logical identity (e.g. VECTOR).
    // Preserve the engine's logical spelling, dimensions and user type identity.
    if (
      !descriptor.nativeType ||
      !Number.isInteger(descriptor.engineType) ||
      !Number.isInteger(descriptor.maxLength) ||
      !Number.isInteger(descriptor.precision) ||
      !Number.isInteger(descriptor.scale) ||
      descriptor.userTypeSchema === undefined ||
      descriptor.userTypeName === undefined
    )
      return undefined;
    return JSON.stringify([
      descriptor.engineType,
      descriptor.nativeType,
      descriptor.maxLength,
      descriptor.precision,
      descriptor.scale,
      descriptor.userTypeSchema,
      descriptor.userTypeName,
    ]);
  },
};
