const SQLITE_NUMERIC_DATABASE_TYPES = Object.freeze(
  new Set([
    "tinyint",
    "smallint",
    "mediumint",
    "int",
    "integer",
    "bigint",
    "decimal",
    "numeric",
    "float",
    "double",
    "real",
    "bit",
    "year",
  ]),
);

export type SqliteAffinity = "integer" | "text" | "blob" | "real" | "numeric";

export function sqliteAffinity(databaseType: string): SqliteAffinity {
  const type = databaseType.trim().toUpperCase();
  if (type.includes("INT")) return "integer";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) return "text";
  if (type.length === 0 || type.includes("BLOB")) return "blob";
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) return "real";
  return "numeric";
}

export function normalizeSqliteDatabaseType(databaseType: string): string {
  return databaseType
    .trim()
    .toLowerCase()
    .replace(/\s+unsigned$/u, "")
    .replace(/\(.*/u, "");
}

function isSqliteNumericDatabaseType(databaseType: string | undefined): boolean {
  return databaseType !== undefined && SQLITE_NUMERIC_DATABASE_TYPES.has(normalizeSqliteDatabaseType(databaseType));
}

export function sqliteNumericOperands(left: string | undefined, right: string | undefined): boolean {
  return isSqliteNumericDatabaseType(left) && isSqliteNumericDatabaseType(right);
}
