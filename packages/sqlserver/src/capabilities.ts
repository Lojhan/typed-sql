import {
  type DialectCapabilityStates,
  type DialectServerEvidence,
  defineDialectCapabilityStates,
  defineDialectServerEvidence,
} from "@typed-sql/core";
import type { SchemaSnapshot } from "@typed-sql/schema";
import { parseSqlServerVersion, sqlServerVersionSupport } from "./support.js";
import { SQLSERVER_DIALECT_VERSION } from "./version.js";
export const SQLSERVER_CAPABILITIES = Object.freeze({
  syntax: true,
  apply: true,
  ctes: true,
  fullJoins: true,
  json: true,
  nativeJson: true,
  output: true,
  pagination: true,
  recursiveCtes: true,
  setOperations: true,
  top: true,
  windows: true,
});
export interface SqlServerServerSettings {
  readonly compatibilityLevel: number;
  readonly collation: string;
  readonly defaultSchema: string;
  readonly quotedIdentifier: boolean;
  readonly ansiWarnings: boolean;
  readonly arithAbort: boolean;
  readonly concatNullYieldsNull: boolean;
  readonly dateFirst: number;
  readonly dateFormat: string;
  readonly language: string;
  readonly databaseName?: string;
  readonly edition?: string;
  readonly engineEdition?: number;
  readonly previewFeatures?: boolean;
}
const keys = new Set([
  "compatibilityLevel",
  "collation",
  "defaultSchema",
  "quotedIdentifier",
  "ansiWarnings",
  "arithAbort",
  "concatNullOn",
  "dateFirst",
  "dateFormat",
  "language",
  "databaseName",
  "edition",
  "engineEdition",
  "previewFeatures",
]);
export function sqlServerServerEvidence(
  version: string,
  settings: SqlServerServerSettings,
  product = "sqlserver",
): DialectServerEvidence {
  const { concatNullYieldsNull, ...rest } = settings;
  const result = defineDialectServerEvidence({
    product,
    version,
    versionKey: parseSqlServerVersion(version)?.major.toString() ?? "unknown",
    features: [],
    settings: { ...rest, concatNullOn: concatNullYieldsNull },
  });
  assertSqlServerServerEvidence(result);
  return result;
}
export function assertSqlServerServerEvidence(server: DialectServerEvidence): void {
  if (server.product !== "sqlserver")
    throw new TypeError("SQL Server evidence must identify the boxed SQL Server product");
  if (Object.keys(server.settings).some((key) => !keys.has(key)))
    throw new TypeError("SQL Server evidence contains unmodeled session settings");
  const parsed = parseSqlServerVersion(server.version);
  if (server.versionKey !== (parsed?.major.toString() ?? "unknown"))
    throw new TypeError("SQL Server versionKey disagrees with its four-part build");
  for (const key of ["quotedIdentifier", "ansiWarnings", "arithAbort", "concatNullOn", "previewFeatures"]) {
    const v = server.settings[key];
    if (v !== undefined && typeof v !== "boolean") throw new TypeError(`SQL Server ${key} must be Boolean`);
  }
  for (const key of ["collation", "defaultSchema", "dateFormat", "language", "databaseName", "edition"]) {
    const v = server.settings[key];
    if (v !== undefined && (typeof v !== "string" || !v || v.length > 200))
      throw new TypeError(`SQL Server ${key} must be bounded text`);
  }
  const level = server.settings.compatibilityLevel;
  if (level !== undefined && (typeof level !== "number" || !Number.isSafeInteger(level) || level < 80 || level > 999))
    throw new TypeError("Invalid SQL Server compatibility level");
  const first = server.settings.dateFirst;
  if (first !== undefined && (typeof first !== "number" || !Number.isInteger(first) || first < 1 || first > 7))
    throw new TypeError("Invalid SQL Server DATEFIRST");
  const engine = server.settings.engineEdition;
  if (engine !== undefined && (!Number.isInteger(engine) || typeof engine !== "number" || engine < 1 || engine > 99))
    throw new TypeError("Invalid SQL Server engine edition");
}
export function resolveSqlServerCapabilities(snapshot: SchemaSnapshot): DialectCapabilityStates {
  const server = snapshot.server;
  if (server) assertSqlServerServerEvidence(server);
  const parsed = server ? parseSqlServerVersion(server.version) : undefined;
  const settings = server?.settings;
  const support =
    server && typeof settings?.compatibilityLevel === "number"
      ? sqlServerVersionSupport(server.version, settings.compatibilityLevel)
      : "conservative";
  const complete =
    settings &&
    [
      "compatibilityLevel",
      "collation",
      "defaultSchema",
      "quotedIdentifier",
      "ansiWarnings",
      "arithAbort",
      "concatNullOn",
      "dateFirst",
      "dateFormat",
      "language",
    ].every((key) => settings[key] !== undefined);
  const productKnown = settings?.engineEdition === undefined || [1, 2, 3, 4].includes(Number(settings.engineEdition));
  const states = Object.fromEntries(
    Object.keys(SQLSERVER_CAPABILITIES).map((name) => {
      const unavailable =
        support === "unsupported" || (name === "nativeJson" && parsed !== undefined && parsed.major < 17);
      const exact =
        !unavailable &&
        support === "supported" &&
        complete &&
        productKnown &&
        settings?.quotedIdentifier === true &&
        settings?.ansiWarnings === true &&
        settings?.arithAbort === true &&
        settings?.concatNullOn === true &&
        settings?.dateFirst === 7 &&
        settings?.dateFormat === "mdy" &&
        settings?.language === "us_english";
      return [
        name,
        {
          level: unavailable ? ("unsupported" as const) : exact ? ("exact" as const) : ("conservative" as const),
          reason: unavailable
            ? "The recorded SQL Server does not implement this capability."
            : exact
              ? "Qualified SQL Server engine, compatibility level and session settings."
              : "Exact analysis requires qualified SQL Server product, version and session evidence.",
          ...(unavailable ? { diagnostic: "TSQ401" } : !exact ? { diagnostic: "TSQ402" } : {}),
          evidence: [
            { kind: "grammar" as const, key: "grammarVersion", value: SQLSERVER_DIALECT_VERSION },
            ...(server
              ? [
                  { kind: "server-version" as const, key: "sqlserver", value: server.version },
                  {
                    kind: "setting" as const,
                    key: "compatibilityLevel",
                    value: String(settings?.compatibilityLevel ?? "unknown"),
                  },
                ]
              : []),
          ],
        },
      ];
    }),
  );
  return defineDialectCapabilityStates(states, Object.keys(SQLSERVER_CAPABILITIES));
}

/** Native adapters attest the actual leased connection; schema files are not runtime dependencies. */
export function assertSqlServerRuntimeEvidence(server: DialectServerEvidence): void {
  assertSqlServerServerEvidence(server);
  const settings = server.settings;
  if (
    typeof settings.compatibilityLevel !== "number" ||
    sqlServerVersionSupport(server.version, settings.compatibilityLevel) !== "supported" ||
    ![1, 2, 3, 4].includes(Number(settings.engineEdition))
  )
    throw new TypeError("SQL Server runtime requires a qualified boxed server build and compatibility level");
  if (
    settings.quotedIdentifier !== true ||
    settings.ansiWarnings !== true ||
    settings.arithAbort !== true ||
    settings.concatNullOn !== true ||
    settings.dateFirst !== 7 ||
    settings.dateFormat !== "mdy" ||
    settings.language !== "us_english" ||
    typeof settings.collation !== "string" ||
    typeof settings.defaultSchema !== "string"
  )
    throw new TypeError(
      "SQL Server runtime requires canonical quoted/ANSI/arithmetic/concatenation settings, DATEFIRST 7, DATEFORMAT mdy and us_english",
    );
}
