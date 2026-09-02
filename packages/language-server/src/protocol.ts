export type TypedSqlProtocolVersionSupport =
  | "supported"
  | "legacy-unversioned"
  | "older-than-supported"
  | "newer-than-supported"
  | "invalid";

export const TYPED_SQL_PROTOCOL_CAPABILITIES = Object.freeze([
  "analysis-identity",
  "diagnostic-fixes",
  "status",
] as const);

export type TypedSqlProtocolCapability = (typeof TYPED_SQL_PROTOCOL_CAPABILITIES)[number];

export interface TypedSqlProtocolNegotiation {
  readonly version: 1;
  readonly client: "legacy-unversioned" | "versioned";
  readonly capabilities: readonly TypedSqlProtocolCapability[];
}

export class TypedSqlProtocolCompatibilityError extends Error {
  readonly code = "TYPED_SQL_PROTOCOL_UNSUPPORTED";
  readonly requestedVersion: unknown;

  constructor(requestedVersion: unknown, support: TypedSqlProtocolVersionSupport) {
    super(
      `typed-sql language-server protocol ${String(requestedVersion)} is ${support}; supported versions: ${TYPED_SQL_PROTOCOL_SUPPORT_POLICY.acceptedVersions.join(", ")}. Update the editor extension and language server together.`,
    );
    this.name = "TypedSqlProtocolCompatibilityError";
    this.requestedVersion = requestedVersion;
  }
}

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

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Negotiates the typed-sql extension protocol embedded in LSP initialization options. */
export function negotiateTypedSqlProtocol(initializationOptions: unknown): TypedSqlProtocolNegotiation {
  const root = object(initializationOptions);
  const typedSql = object(root?.typedSql) ?? root;
  const protocol = object(typedSql?.protocol);
  const version = protocol?.version ?? typedSql?.protocolVersion;
  const support = typedSqlProtocolVersionSupport(version);
  if (support !== "supported" && support !== "legacy-unversioned") {
    throw new TypedSqlProtocolCompatibilityError(version, support);
  }
  const requested = protocol?.capabilities ?? typedSql?.protocolCapabilities;
  if (requested !== undefined && (!Array.isArray(requested) || requested.some((item) => typeof item !== "string"))) {
    throw new TypedSqlProtocolCompatibilityError(version, "invalid");
  }
  const requestedCapabilities = requested === undefined ? TYPED_SQL_PROTOCOL_CAPABILITIES : new Set(requested);
  const capabilities = Object.freeze(
    TYPED_SQL_PROTOCOL_CAPABILITIES.filter((capability) =>
      requestedCapabilities instanceof Set ? requestedCapabilities.has(capability) : true,
    ),
  );
  return Object.freeze({
    version: TYPED_SQL_PROTOCOL_VERSION,
    client: support === "legacy-unversioned" ? "legacy-unversioned" : "versioned",
    capabilities,
  });
}
