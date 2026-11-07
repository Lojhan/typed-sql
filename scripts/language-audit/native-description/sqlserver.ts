import type { NativeDescriptionMapper } from "./contracts.js";

// ODBC command adapters can return numeric descriptor columns as decimal text.
// Decode only complete safe integers; missing values must not become zero.
const nativeInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number" && !(typeof value === "string" && /^-?\d+$/u.test(value))) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
};

export const sqlServerDescription: NativeDescriptionMapper = {
  id: "sqlserver",
  claimSql: (type) => `SELECT CAST(NULL AS ${type}) AS value`,
  identity: (descriptor) => {
    // system_type_id alone is physical storage, not logical identity (e.g. VECTOR).
    // Preserve the engine's logical spelling, dimensions and user type identity.
    const dimensions = [descriptor.engineType, descriptor.maxLength, descriptor.precision, descriptor.scale].map(
      nativeInteger,
    );
    if (
      !descriptor.nativeType ||
      dimensions.some((value) => value === undefined) ||
      descriptor.userTypeSchema === undefined ||
      descriptor.userTypeName === undefined
    )
      return undefined;
    // These are documented identical logical types, despite distinct native IDs. This exception
    // does not infer aliases from a shared storage ID and never drops dimensions/user identity.
    // https://learn.microsoft.com/sql/t-sql/data-types/decimal-and-numeric-transact-sql
    const synonym = (
      dimensions[0] === 106 ? /^decimal(\(\d+,\d+\))$/u : dimensions[0] === 108 ? /^numeric(\(\d+,\d+\))$/u : undefined
    )?.exec(descriptor.nativeType);
    return JSON.stringify([
      synonym ? "decimal-numeric" : dimensions[0],
      synonym ? `decimal${synonym[1]}` : descriptor.nativeType,
      ...dimensions.slice(1),
      descriptor.userTypeSchema,
      descriptor.userTypeName,
    ]);
  },
};
