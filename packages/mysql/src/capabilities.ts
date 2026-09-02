import {
  type DialectCapabilityEvidence,
  type DialectCapabilityStates,
  type DialectServerEvidence,
  defineDialectCapabilityStates,
  defineDialectServerEvidence,
  staticDialectCapabilityStates,
} from "@typed-sql/core";
import type { MySqlSchemaSnapshot } from "./index.js";
import { type MySqlVersionPolicy, mySqlVersionSupport, parseMySqlVersion } from "./support.js";
import { MYSQL_DIALECT_VERSION } from "./version.js";

export const MYSQL_CAPABILITIES = Object.freeze({
  aggregateFilter: false,
  arrays: false,
  distinctOn: false,
  fullJoins: false,
  lockingReads: true,
  recursiveCtes: false,
  returning: false,
  setOperations: false,
});

export function assertMySqlServerEvidence(server: DialectServerEvidence): void {
  const settings = Object.keys(server.settings);
  if (settings.some((key) => key !== "sqlMode")) {
    throw new TypeError("MySQL server evidence contains a non-allowlisted semantic setting");
  }
  const sqlMode = server.settings.sqlMode;
  if (sqlMode !== undefined && (typeof sqlMode !== "string" || normalizeSqlMode(sqlMode) !== sqlMode)) {
    throw new TypeError("MySQL sqlMode evidence must be a normalized mode list");
  }
  if (server.features.length > 0) throw new TypeError("MySQL server evidence does not allow feature identifiers");
}

function normalizeSqlMode(value: string): string {
  return [
    ...new Set(
      value
        .split(",")
        .map((mode) => mode.trim().toUpperCase())
        .filter(Boolean),
    ),
  ]
    .sort()
    .join(",");
}

export function mySqlServerEvidence(version: string, sqlMode?: string): DialectServerEvidence {
  const parsed = parseMySqlVersion(version);
  if (parsed === undefined) throw new TypeError(`Cannot normalize MySQL version ${JSON.stringify(version)}`);
  return defineDialectServerEvidence({
    product: /mariadb/iu.test(version) ? "mariadb" : "mysql",
    version,
    versionKey: parsed.join("."),
    features: [],
    settings: sqlMode === undefined ? {} : { sqlMode: normalizeSqlMode(sqlMode) },
  });
}

function serverConditions(
  server: DialectServerEvidence,
  versionPolicy: MySqlVersionPolicy,
): DialectCapabilityEvidence[] {
  return [
    { kind: "policy", key: "versionChannel", value: versionPolicy },
    ...Object.entries(server.settings).map(([key, value]) => ({
      kind: "setting" as const,
      key,
      value: String(value) || "<empty>",
    })),
  ];
}

function conservativeStates(
  reason: string,
  server?: DialectServerEvidence,
  diagnostic = "TSQ402",
  versionPolicy: MySqlVersionPolicy = "stable",
): DialectCapabilityStates {
  const evidence: DialectCapabilityEvidence[] = [
    { kind: "grammar", key: "grammarVersion", value: MYSQL_DIALECT_VERSION },
    ...(server === undefined
      ? []
      : [{ kind: "server-version" as const, key: server.product, value: server.versionKey }]),
    ...(server === undefined
      ? [{ kind: "policy" as const, key: "versionChannel", value: versionPolicy }]
      : serverConditions(server, versionPolicy)),
  ];
  return defineDialectCapabilityStates(
    Object.fromEntries(
      Object.entries(MYSQL_CAPABILITIES).map(([capability, supported]) => [
        capability,
        supported
          ? { level: "conservative", reason, diagnostic, evidence }
          : {
              level: "unsupported",
              reason: "This MySQL grammar version does not implement the feature.",
              diagnostic: "TSQ401",
              evidence,
            },
      ]),
    ),
    Object.keys(MYSQL_CAPABILITIES),
  );
}

export function resolveMySqlCapabilities(
  snapshot: MySqlSchemaSnapshot,
  versionPolicy: MySqlVersionPolicy = "stable",
): DialectCapabilityStates {
  let server = snapshot.server;
  if (server === undefined && snapshot.version !== undefined) {
    try {
      server = mySqlServerEvidence(snapshot.version);
    } catch {
      return conservativeStates(
        "The MySQL server version could not be normalized.",
        undefined,
        "TSQ402",
        versionPolicy,
      );
    }
  }
  if (server === undefined) {
    return conservativeStates(
      "Exact support requires MySQL server-version evidence.",
      undefined,
      "TSQ402",
      versionPolicy,
    );
  }
  assertMySqlServerEvidence(server);
  if (server.product !== "mysql") {
    return conservativeStates(
      `${server.product} is not covered by the MySQL grammar support contract.`,
      server,
      "TSQ403",
      versionPolicy,
    );
  }
  const version = parseMySqlVersion(server.versionKey);
  if (version === undefined) {
    return conservativeStates("The MySQL server version could not be normalized.", server, "TSQ402", versionPolicy);
  }
  const support = mySqlVersionSupport(server.version, versionPolicy);
  if (support === "prerelease") {
    return conservativeStates(
      "Pre-release MySQL versions require an explicit canary support policy.",
      server,
      "TSQ403",
      versionPolicy,
    );
  }
  if (support !== "supported" && support !== "canary") {
    return conservativeStates(
      `MySQL ${version.join(".")} is not in the tested 8.4 or 9.7 LTS support lines.`,
      server,
      "TSQ403",
      versionPolicy,
    );
  }
  const sqlMode = server.settings.sqlMode;
  if (typeof sqlMode !== "string") {
    return conservativeStates(
      "Exact MySQL lexical analysis requires normalized sql_mode evidence.",
      server,
      "TSQ402",
      versionPolicy,
    );
  }
  const modes = new Set(sqlMode.split(",").filter(Boolean));
  const ambiguousModes = ["ANSI_QUOTES", "NO_BACKSLASH_ESCAPES", "PIPES_AS_CONCAT"].filter((mode) => modes.has(mode));
  if (ambiguousModes.length > 0) {
    return conservativeStates(
      `MySQL sql_mode enables syntax not modeled exactly: ${ambiguousModes.join(", ")}.`,
      server,
      "TSQ407",
      versionPolicy,
    );
  }
  return staticDialectCapabilityStates(
    MYSQL_CAPABILITIES,
    MYSQL_DIALECT_VERSION,
    server,
    "TSQ401",
    serverConditions(server, versionPolicy),
  );
}
