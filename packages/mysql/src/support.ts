export type MySqlVersion = readonly [major: number, minor: number, patch: number];
export type MySqlVersionPolicy = "stable" | "canary";
export type MySqlVersionSupport =
  | "supported"
  | "canary"
  | "below-supported"
  | "unsupported-line"
  | "newer-than-tested"
  | "prerelease"
  | "unknown";

/**
 * Grammar-owned release boundary. Exact targets become release evidence only after the differential
 * matrix records them; support remains patch-compatible within an approved LTS line.
 */
export const MYSQL_SUPPORT_POLICY = Object.freeze({
  stable: Object.freeze([
    Object.freeze({ series: "8.4", matrixVersion: "8.4.12" }),
    Object.freeze({ series: "9.7", matrixVersion: "9.7.3" }),
  ] as const),
  canary: Object.freeze({ series: "26.7", matrixVersion: "26.7.1", channel: "innovation" as const }),
  patchCompatibility: "within-lts-series",
  upstreamPolicy: "supported-lts-series",
  innovationPolicy: "canary-only",
  upstreamSupportWindow: "premier-and-extended",
  deprecation: Object.freeze({
    noticeBeforeUpstreamEndDays: 90,
    removal: "first-typed-sql-minor-after-upstream-support-end",
  }),
} as const);

export function parseMySqlVersion(value: string): MySqlVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\D.*)?$/u.exec(value.trim());
  if (match === null) return undefined;
  const version = match.slice(1, 4).map(Number) as unknown as MySqlVersion;
  return version.every(Number.isSafeInteger) ? version : undefined;
}

function series(version: MySqlVersion): string {
  return `${version[0]}.${version[1]}`;
}

function compare(left: MySqlVersion, right: MySqlVersion): number {
  for (let offset = 0; offset < 3; offset += 1) {
    const difference = left[offset]! - right[offset]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function mySqlVersionSupport(value: string, versionPolicy: MySqlVersionPolicy = "stable"): MySqlVersionSupport {
  const version = parseMySqlVersion(value);
  if (version === undefined) return "unknown";
  const selectedSeries = series(version);
  const prerelease = /(?:alpha|beta|rc|devel)/iu.test(value);
  const canary = selectedSeries === MYSQL_SUPPORT_POLICY.canary.series;
  if (prerelease && !(canary && versionPolicy === "canary")) return "prerelease";
  if (MYSQL_SUPPORT_POLICY.stable.some((target) => target.series === selectedSeries)) return "supported";
  if (canary) return versionPolicy === "canary" ? "canary" : "unsupported-line";
  const minimum = parseMySqlVersion(`${MYSQL_SUPPORT_POLICY.stable[0].series}.0`)!;
  const maximum = parseMySqlVersion(`${MYSQL_SUPPORT_POLICY.canary.series}.0`)!;
  if (compare(version, minimum) < 0) return "below-supported";
  if (compare(version, maximum) > 0) return "newer-than-tested";
  return "unsupported-line";
}
