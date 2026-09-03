export const SQLITE_LANGUAGE_SUPPORT = Object.freeze({
  minimum: "3.39.0",
  maximum: "3.53.4",
  unknownVersion: "conservative",
  newerVersion: "conservative",
} as const);

export const NODE_SQLITE_RUNTIME_SUPPORT = Object.freeze({
  minimum: "22.13.0",
  lines: Object.freeze([22, 24, 26] as const),
  execution: "synchronous",
  cancellation: false,
} as const);

export type SqliteVersion = readonly [major: number, minor: number, patch: number];
export type SqliteVersionSupport = "supported" | "below-supported" | "newer-than-tested" | "prerelease" | "unknown";

export function parseSqliteVersion(value: string): SqliteVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\D.*)?$/u.exec(value.trim());
  if (match === null) return undefined;
  const version = match.slice(1, 4).map(Number) as unknown as SqliteVersion;
  return version.every(Number.isSafeInteger) ? version : undefined;
}

export function compareSqliteVersions(left: SqliteVersion, right: SqliteVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function sqliteVersionSupport(value: string): SqliteVersionSupport {
  const parsed = parseSqliteVersion(value);
  if (parsed === undefined) return "unknown";
  if (/(?:alpha|beta|rc)/iu.test(value)) return "prerelease";
  if (compareSqliteVersions(parsed, parseSqliteVersion(SQLITE_LANGUAGE_SUPPORT.minimum)!) < 0) {
    return "below-supported";
  }
  if (compareSqliteVersions(parsed, parseSqliteVersion(SQLITE_LANGUAGE_SUPPORT.maximum)!) > 0) {
    return "newer-than-tested";
  }
  return "supported";
}

export function isNodeSqliteRuntimeSupported(value: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\D.*)?$/u.exec(value.trim());
  if (match === null) return false;
  const actual = match.slice(1, 4).map(Number);
  if (!NODE_SQLITE_RUNTIME_SUPPORT.lines.includes(actual[0] as 22 | 24 | 26)) return false;
  const minimum = NODE_SQLITE_RUNTIME_SUPPORT.minimum.split(".").map(Number);
  if (actual[0] !== minimum[0]) return true;
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = actual[index]! - minimum[index]!;
    if (difference !== 0) return difference > 0;
  }
  return true;
}
