import type { NativeDescriptionMapper } from "./contracts.js";

export const postgresDescription: NativeDescriptionMapper = {
  id: "postgres",
  claimSql: (type) => {
    // databaseType is a native type identity, not a column declaration. format_type(...,NULL)
    // uses these SQL spellings even for typmod -1; bare SQL BIT/CHARACTER declarations add (1).
    // Qualify only the unmodified identities. Explicit dimensions still go through native parsing.
    const unmodified: Readonly<Record<string, string>> = { bit: "pg_catalog.bit", character: "pg_catalog.bpchar" };
    return `SELECT CAST(NULL AS ${unmodified[type.trim().toLowerCase()] ?? type}) AS value`;
  },
  identity: (descriptor, scope) => {
    if (!Number.isInteger(descriptor.engineType) || descriptor.engineType! <= 0) return undefined;
    // ParameterDescription supplies OIDs only; RowDescription also supplies atttypmod.
    // https://www.postgresql.org/docs/current/protocol-message-formats.html
    if (scope === "parameter") return JSON.stringify([descriptor.engineType]);
    if (!Number.isInteger(descriptor.typeModifier)) return undefined;
    return JSON.stringify([descriptor.engineType, descriptor.typeModifier]);
  },
};
