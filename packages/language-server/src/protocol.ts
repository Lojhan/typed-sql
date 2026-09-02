export type TypedSqlProtocolVersionSupport =
  | "supported"
  | "legacy-unversioned"
  | "older-than-supported"
  | "newer-than-supported"
  | "invalid";

/** Public compatibility boundary for typed-sql-specific LSP requests and initialization data. */
export const TYPED_SQL_PROTOCOL_SUPPORT_POLICY = Object.freeze({
  currentVersion: 1,
  acceptedVersions: Object.freeze([1] as const),
  legacyUnversionedClients: "accepted-as-version-1",
  compatibilityWindow: "current-protocol-version",
  deprecation: Object.freeze({
    notice: "at-least-one-language-server-minor",
    removal: "language-server-major-only",
  }),
} as const);

export const TYPED_SQL_PROTOCOL_VERSION = TYPED_SQL_PROTOCOL_SUPPORT_POLICY.currentVersion;

export function typedSqlProtocolVersionSupport(version: unknown): TypedSqlProtocolVersionSupport {
  if (version === undefined) return "legacy-unversioned";
  if (!Number.isSafeInteger(version) || (version as number) < 1) return "invalid";
  if (TYPED_SQL_PROTOCOL_SUPPORT_POLICY.acceptedVersions.includes(version as 1)) return "supported";
  return (version as number) < TYPED_SQL_PROTOCOL_SUPPORT_POLICY.acceptedVersions[0]
    ? "older-than-supported"
    : "newer-than-supported";
}
