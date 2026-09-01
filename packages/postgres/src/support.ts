export type PostgresVersionPolicy = "stable" | "canary";
export type PostgresVersionSupport =
  | "supported"
  | "canary"
  | "below-supported"
  | "newer-than-tested"
  | "prerelease"
  | "unknown";

/**
 * Grammar-owned release boundary. Minor targets are refreshed from PostgreSQL's upstream support
 * table and become release evidence only after the differential matrix records them.
 */
export const POSTGRES_SUPPORT_POLICY = Object.freeze({
  stableMajors: Object.freeze([14, 15, 16, 17, 18] as const),
  matrixMinors: Object.freeze({
    14: "14.24",
    15: "15.19",
    16: "16.15",
    17: "17.11",
    18: "18.6",
  } as const),
  canary: Object.freeze({ major: 19, version: "19beta3" }),
  minorCompatibility: "within-major",
  upstreamPolicy: "all-upstream-supported-majors",
  deprecation: Object.freeze({
    noticeBeforeUpstreamEolDays: 90,
    removal: "first-typed-sql-minor-after-upstream-eol",
  }),
} as const);

export function parsePostgresMajor(value: string): number | undefined {
  const match = /^(\d+)(?:\.\d+)?(?:\D.*)?$/u.exec(value.trim());
  if (match === null) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major > 0 ? major : undefined;
}

export function postgresVersionSupport(
  value: string,
  versionPolicy: PostgresVersionPolicy = "stable",
): PostgresVersionSupport {
  const major = parsePostgresMajor(value);
  if (major === undefined) return "unknown";
  const prerelease = /(?:alpha|beta|rc|devel)/iu.test(value);
  if (major === POSTGRES_SUPPORT_POLICY.canary.major) {
    return versionPolicy === "canary" ? "canary" : prerelease ? "prerelease" : "newer-than-tested";
  }
  if (prerelease) return "prerelease";
  if (POSTGRES_SUPPORT_POLICY.stableMajors.includes(major as 14 | 15 | 16 | 17 | 18)) return "supported";
  if (major < POSTGRES_SUPPORT_POLICY.stableMajors[0]) return "below-supported";
  return "newer-than-tested";
}
