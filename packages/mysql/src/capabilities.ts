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

export type MySqlServerEdition = "commercial" | "community" | "enterprise" | "source" | "unknown";

export interface MySqlServerEvidenceOptions {
  readonly sqlMode?: string;
  readonly characterSetServer?: string;
  readonly collationServer?: string;
  readonly characterSetConnection?: string;
  readonly collationConnection?: string;
  readonly timeZone?: string;
  readonly systemTimeZone?: string;
  readonly lowerCaseTableNames?: number | string;
  readonly versionComment?: string;
}

const mysqlSettingKeys = Object.freeze([
  "characterSetConnection",
  "characterSetServer",
  "collationConnection",
  "collationServer",
  "edition",
  "lowerCaseTableNames",
  "sqlMode",
  "systemTimeZone",
  "timeZone",
] as const);

const exactMySqlSettingKeys = Object.freeze([...mysqlSettingKeys]);

export function assertMySqlServerEvidence(server: DialectServerEvidence): void {
  const settings = Object.keys(server.settings);
  if (settings.some((key) => !mysqlSettingKeys.includes(key as (typeof mysqlSettingKeys)[number]))) {
    throw new TypeError("MySQL server evidence contains a non-allowlisted semantic setting");
  }
  const sqlMode = server.settings.sqlMode;
  if (sqlMode !== undefined && (typeof sqlMode !== "string" || normalizeSqlMode(sqlMode) !== sqlMode)) {
    throw new TypeError("MySQL sqlMode evidence must be a normalized mode list");
  }
  for (const key of [
    "characterSetConnection",
    "characterSetServer",
    "collationConnection",
    "collationServer",
  ] as const) {
    const value = server.settings[key];
    if (value !== undefined && (typeof value !== "string" || normalizeIdentifier(value, key) !== value)) {
      throw new TypeError(`MySQL ${key} evidence must be a normalized identifier`);
    }
  }
  for (const key of ["timeZone", "systemTimeZone"] as const) {
    const value = server.settings[key];
    if (value !== undefined && (typeof value !== "string" || normalizeTimeZone(value) !== value)) {
      throw new TypeError(`MySQL ${key} evidence must be normalized`);
    }
  }
  const lowerCaseTableNames = server.settings.lowerCaseTableNames;
  if (lowerCaseTableNames !== undefined && ![0, 1, 2].includes(lowerCaseTableNames as number)) {
    throw new TypeError("MySQL lowerCaseTableNames evidence must be 0, 1, or 2");
  }
  const edition = server.settings.edition;
  if (
    edition !== undefined &&
    (typeof edition !== "string" || !["commercial", "community", "enterprise", "source", "unknown"].includes(edition))
  ) {
    throw new TypeError("MySQL edition evidence is invalid");
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

function normalizeIdentifier(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/u.test(normalized)) throw new TypeError(`MySQL ${name} is not a safe identifier`);
  return normalized;
}

function normalizeTimeZone(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    [...normalized].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new TypeError("MySQL time-zone evidence is invalid");
  }
  return /^system$/iu.test(normalized) ? "SYSTEM" : normalized;
}

function normalizeLowerCaseTableNames(value: number | string): number {
  const normalized = typeof value === "string" && /^[012]$/u.test(value.trim()) ? Number(value.trim()) : value;
  if (normalized !== 0 && normalized !== 1 && normalized !== 2) {
    throw new TypeError("MySQL lower_case_table_names must be 0, 1, or 2");
  }
  return normalized;
}

function mysqlServerEdition(comment: string | undefined): MySqlServerEdition {
  if (comment === undefined) return "unknown";
  if (/community/iu.test(comment)) return "community";
  if (/enterprise/iu.test(comment)) return "enterprise";
  if (/commercial/iu.test(comment)) return "commercial";
  if (/source distribution/iu.test(comment)) return "source";
  return "unknown";
}

function mysqlServerProduct(version: string, comment: string | undefined): string {
  const identity = `${version}\n${comment ?? ""}`;
  if (/mariadb/iu.test(identity)) return "mariadb";
  if (/(?:percona|tidb|vitess|planetscale|aurora)/iu.test(identity)) return "mysql-compatible";
  if (comment === undefined || /mysql|source distribution/iu.test(comment)) return "mysql";
  return "mysql-compatible";
}

export function mySqlServerEvidence(
  version: string,
  sqlModeOrOptions?: string | MySqlServerEvidenceOptions,
): DialectServerEvidence {
  const parsed = parseMySqlVersion(version);
  if (parsed === undefined) throw new TypeError(`Cannot normalize MySQL version ${JSON.stringify(version)}`);
  const options = typeof sqlModeOrOptions === "string" ? { sqlMode: sqlModeOrOptions } : (sqlModeOrOptions ?? {});
  const settings = {
    ...(options.sqlMode === undefined ? {} : { sqlMode: normalizeSqlMode(options.sqlMode) }),
    ...(options.characterSetServer === undefined
      ? {}
      : { characterSetServer: normalizeIdentifier(options.characterSetServer, "characterSetServer") }),
    ...(options.collationServer === undefined
      ? {}
      : { collationServer: normalizeIdentifier(options.collationServer, "collationServer") }),
    ...(options.characterSetConnection === undefined
      ? {}
      : { characterSetConnection: normalizeIdentifier(options.characterSetConnection, "characterSetConnection") }),
    ...(options.collationConnection === undefined
      ? {}
      : { collationConnection: normalizeIdentifier(options.collationConnection, "collationConnection") }),
    ...(options.timeZone === undefined ? {} : { timeZone: normalizeTimeZone(options.timeZone) }),
    ...(options.systemTimeZone === undefined ? {} : { systemTimeZone: normalizeTimeZone(options.systemTimeZone) }),
    ...(options.lowerCaseTableNames === undefined
      ? {}
      : { lowerCaseTableNames: normalizeLowerCaseTableNames(options.lowerCaseTableNames) }),
    ...(options.versionComment === undefined ? {} : { edition: mysqlServerEdition(options.versionComment) }),
  };
  return defineDialectServerEvidence({
    product: mysqlServerProduct(version, options.versionComment),
    version,
    versionKey: parsed.join("."),
    features: [],
    settings,
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
  const missingSettings = exactMySqlSettingKeys.filter((key) => !Object.hasOwn(server.settings, key));
  if (missingSettings.length > 0) {
    return conservativeStates(
      `Exact MySQL analysis requires normalized server settings: ${missingSettings.join(", ")}.`,
      server,
      "TSQ402",
      versionPolicy,
    );
  }
  if (server.settings.edition === "unknown") {
    return conservativeStates(
      "The MySQL server edition could not be identified as an approved distribution.",
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
