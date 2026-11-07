import { sqliteAsciiFold, sqliteAsciiUpper } from "../identifier-case.js";
import { affinityRules, defaultAffinity, numericTypeNames } from "./generated/types.js";

const SQLITE_NUMERIC_DATABASE_TYPES: ReadonlySet<string> = new Set(numericTypeNames);

export type SqliteAffinity = "integer" | "text" | "blob" | "real" | "numeric";

export function sqliteAffinity(databaseType: string): SqliteAffinity {
  const type = sqliteAsciiUpper(databaseType.trim());
  return (
    affinityRules.find(
      (rule) => rule.contains.some((pattern) => type.includes(pattern)) || (rule.empty && type.length === 0),
    )?.affinity ?? defaultAffinity
  );
}

export function normalizeSqliteDatabaseType(databaseType: string): string {
  return sqliteAsciiFold(databaseType.trim())
    .replace(/\s+unsigned$/u, "")
    .replace(/\(.*/u, "");
}

function isSqliteNumericDatabaseType(databaseType: string | undefined): boolean {
  return databaseType !== undefined && SQLITE_NUMERIC_DATABASE_TYPES.has(normalizeSqliteDatabaseType(databaseType));
}

export function sqliteNumericOperands(left: string | undefined, right: string | undefined): boolean {
  return isSqliteNumericDatabaseType(left) && isSqliteNumericDatabaseType(right);
}
