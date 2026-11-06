export interface SqlServerVersion {
  readonly major: number;
  readonly minor: number;
  readonly build: number;
  readonly revision: number;
  readonly text: string;
}
export const SQLSERVER_LANGUAGE_SUPPORT = Object.freeze({
  engineMajors: Object.freeze([14, 15, 16, 17]),
  compatibilityLevels: Object.freeze([140, 150, 160, 170]),
  maximumParameters: 2100,
});
export function parseSqlServerVersion(source: string): SqlServerVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(source);
  if (!match) return undefined;
  const numbers = match.slice(1).map(Number);
  if (numbers.some((n) => !Number.isSafeInteger(n) || n < 0)) return undefined;
  return Object.freeze({
    major: numbers[0]!,
    minor: numbers[1]!,
    build: numbers[2]!,
    revision: numbers[3]!,
    text: source,
  });
}
export function sqlServerVersionSupport(
  version: string,
  compatibilityLevel: number,
): "supported" | "unsupported" | "conservative" {
  const parsed = parseSqlServerVersion(version);
  if (!parsed) return "conservative";
  if (parsed.major < 14) return "unsupported";
  if (!SQLSERVER_LANGUAGE_SUPPORT.engineMajors.includes(parsed.major) || parsed.minor !== 0) return "conservative";
  if (!Number.isSafeInteger(compatibilityLevel) || compatibilityLevel < 140 || compatibilityLevel > parsed.major * 10)
    return "conservative";
  return SQLSERVER_LANGUAGE_SUPPORT.compatibilityLevels.includes(compatibilityLevel) ? "supported" : "conservative";
}
