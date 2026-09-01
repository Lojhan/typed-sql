import {
  type DialectCapabilityEvidence,
  type DialectCapabilityStates,
  type DialectServerEvidence,
  defineDialectCapabilityStates,
  defineDialectServerEvidence,
  staticDialectCapabilityStates,
} from "@typed-sql/core";
import type { PostgresSchemaSnapshot } from "./index.js";
import {
  POSTGRES_SUPPORT_POLICY,
  type PostgresVersionPolicy,
  parsePostgresMajor,
  postgresVersionSupport,
} from "./support.js";
import { POSTGRES_DIALECT_VERSION } from "./version.js";

export type { PostgresVersionPolicy } from "./support.js";
export { parsePostgresMajor } from "./support.js";

export const POSTGRES_CAPABILITIES = Object.freeze({
  aggregateFilter: true,
  arrays: true,
  distinctOn: true,
  fullJoins: true,
  lockingReads: true,
  recursiveCtes: true,
  returning: true,
  setOperations: true,
});

export function assertPostgresServerEvidence(server: DialectServerEvidence): void {
  const major = parsePostgresMajor(server.version);
  if (major === undefined || parsePostgresMajor(server.versionKey) !== major) {
    throw new TypeError("PostgreSQL server versionKey must match the normalized server major");
  }
  const settings = Object.keys(server.settings);
  if (settings.some((key) => !["searchPath", "standardConformingStrings", "visibilityScope"].includes(key))) {
    throw new TypeError("PostgreSQL server evidence contains a non-allowlisted semantic setting");
  }
  const strings = server.settings.standardConformingStrings;
  if (strings !== undefined && strings !== "on" && strings !== "off") {
    throw new TypeError("PostgreSQL standardConformingStrings evidence must be on or off");
  }
  const searchPath = server.settings.searchPath;
  if (searchPath !== undefined && (typeof searchPath !== "string" || searchPath.length === 0)) {
    throw new TypeError("PostgreSQL searchPath evidence must be a non-empty string");
  }
  const visibilityScope = server.settings.visibilityScope;
  if (visibilityScope !== undefined && visibilityScope !== "current-role") {
    throw new TypeError("PostgreSQL visibilityScope evidence must be current-role");
  }
  if (server.features.some((feature) => !/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.+-]+$/u.test(feature))) {
    throw new TypeError("PostgreSQL server features must be normalized extension name/version identities");
  }
}

export function postgresServerEvidence(
  version: string,
  features: readonly string[] = [],
  settings: Readonly<Record<string, string | boolean | number>> = {},
): DialectServerEvidence {
  const major = parsePostgresMajor(version);
  if (major === undefined) throw new TypeError(`Cannot normalize PostgreSQL version ${JSON.stringify(version)}`);
  return defineDialectServerEvidence({
    product: "postgres",
    version,
    versionKey: String(major),
    features: [...features],
    settings,
  });
}

function serverConditions(
  server: DialectServerEvidence,
  versionPolicy: PostgresVersionPolicy,
): DialectCapabilityEvidence[] {
  return [
    { kind: "policy", key: "versionChannel", value: versionPolicy },
    ...server.features.map((feature) => ({ kind: "feature" as const, key: feature, value: "present" })),
    ...Object.entries(server.settings).map(([key, value]) => ({
      kind: "setting" as const,
      key,
      value: String(value),
    })),
  ];
}

function conservativeStates(
  reason: string,
  server?: DialectServerEvidence,
  diagnostic = "TSQ402",
  versionPolicy: PostgresVersionPolicy = "stable",
): DialectCapabilityStates {
  const evidence: DialectCapabilityEvidence[] = [
    { kind: "grammar", key: "grammarVersion", value: POSTGRES_DIALECT_VERSION },
    ...(server === undefined ? [] : [{ kind: "server-version" as const, key: "postgres", value: server.versionKey }]),
    ...(server === undefined
      ? [{ kind: "policy" as const, key: "versionChannel", value: versionPolicy }]
      : serverConditions(server, versionPolicy)),
  ];
  return defineDialectCapabilityStates(
    Object.fromEntries(
      Object.entries(POSTGRES_CAPABILITIES).map(([capability, supported]) => [
        capability,
        supported
          ? { level: "conservative", reason, diagnostic, evidence }
          : {
              level: "unsupported",
              reason: "This PostgreSQL grammar version does not implement the feature.",
              diagnostic: "TSQ401",
              evidence,
            },
      ]),
    ),
    Object.keys(POSTGRES_CAPABILITIES),
  );
}

export function resolvePostgresCapabilities(
  snapshot: PostgresSchemaSnapshot,
  versionPolicy: PostgresVersionPolicy = "stable",
): DialectCapabilityStates {
  let server = snapshot.server;
  if (server === undefined && snapshot.version !== undefined) {
    try {
      server = postgresServerEvidence(snapshot.version);
    } catch {
      return conservativeStates(
        "The PostgreSQL server version could not be normalized.",
        undefined,
        "TSQ402",
        versionPolicy,
      );
    }
  }
  if (server === undefined) {
    return conservativeStates(
      "Exact support requires PostgreSQL server-version evidence.",
      undefined,
      "TSQ402",
      versionPolicy,
    );
  }
  assertPostgresServerEvidence(server);
  if (server.product !== "postgres") {
    return conservativeStates(`${server.product} is not PostgreSQL server evidence.`, server, "TSQ403", versionPolicy);
  }
  const major = parsePostgresMajor(server.versionKey);
  if (major === undefined) {
    return conservativeStates(
      "The PostgreSQL server version could not be normalized.",
      server,
      "TSQ402",
      versionPolicy,
    );
  }
  const support = postgresVersionSupport(server.version, versionPolicy);
  if (support === "prerelease") {
    return conservativeStates(
      "Pre-release PostgreSQL versions require an explicit canary support policy.",
      server,
      "TSQ403",
      versionPolicy,
    );
  }
  if (support !== "supported" && support !== "canary") {
    const minimum = POSTGRES_SUPPORT_POLICY.stableMajors[0];
    const maximum = POSTGRES_SUPPORT_POLICY.stableMajors.at(-1)!;
    return conservativeStates(
      `PostgreSQL ${major} is outside the tested ${minimum}-${maximum} support band.`,
      server,
      "TSQ403",
      versionPolicy,
    );
  }
  if (server.settings.standardConformingStrings !== "on") {
    return conservativeStates(
      server.settings.standardConformingStrings === undefined
        ? "Exact PostgreSQL lexical analysis requires standard_conforming_strings evidence."
        : "standard_conforming_strings=off is outside the exact lexical policy.",
      server,
      server.settings.standardConformingStrings === undefined ? "TSQ402" : "TSQ407",
      versionPolicy,
    );
  }
  return staticDialectCapabilityStates(
    POSTGRES_CAPABILITIES,
    POSTGRES_DIALECT_VERSION,
    server,
    "TSQ401",
    serverConditions(server, versionPolicy),
  );
}
