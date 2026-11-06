import {
  type DialectCapabilityStates,
  type DialectServerEvidence,
  defineDialectCapabilityStates,
  defineDialectServerEvidence,
  type SchemaSnapshot,
} from "@typed-sql/core";
import { DUCKDB_DIALECT_VERSION } from "./version.js";
export const DUCKDB_SUPPORT_POLICY = Object.freeze({
  qualifiedEngines: Object.freeze(["1.5.6", "2.0.0"] as const),
  nodeApi: Object.freeze({ "1.5.6": "1.5.6-r.2", "2.0.0": "2.0.0-r.1" }),
  unknownNewer: "conservative",
  minimum: "1.5.6",
} as const);
export type DuckDBVersionSupport = "supported" | "below-supported" | "newer-than-tested" | "prerelease" | "unknown";
export function parseDuckDBVersion(value: string): string | undefined {
  return /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(value)?.slice(1).map(Number).join(".");
}
export function duckDBVersionSupport(value: string): DuckDBVersionSupport {
  const normalized = parseDuckDBVersion(value);
  if (!normalized) return /^v?\d+\.\d+\.\d+[-+]/u.test(value) ? "prerelease" : "unknown";
  if ((DUCKDB_SUPPORT_POLICY.qualifiedEngines as readonly string[]).includes(normalized)) return "supported";
  return normalized.localeCompare("1.5.6", undefined, { numeric: true }) < 0 ? "below-supported" : "newer-than-tested";
}
export function duckDBServerEvidence(
  version: string,
  features: readonly string[] = [],
  settings: Readonly<Record<string, string | number | boolean>> = {},
): DialectServerEvidence {
  const versionKey = parseDuckDBVersion(version);
  if (!versionKey) throw new TypeError("Invalid DuckDB engine version");
  return defineDialectServerEvidence({
    product: "duckdb",
    version,
    versionKey,
    features: [...new Set(features)].sort(),
    settings,
  });
}
export const DUCKDB_CAPABILITIES = Object.freeze({
  aggregateFilter: true,
  arrays: true,
  backtickIdentifiers: true,
  distinctOn: true,
  fullJoins: true,
  lockingReads: false,
  maps: true,
  modifyingCtes: true,
  nanosecondTimestampTZ: true,
  recursiveCtes: true,
  returning: true,
  setOperations: true,
  structs: true,
  unions: true,
  unnest: true,
  variant: false,
  windowQualify: true,
});
export function resolveDuckDBCapabilities(snapshot: SchemaSnapshot): DialectCapabilityStates {
  const version = snapshot.server?.versionKey ?? snapshot.version ?? "missing";
  const supported = snapshot.server?.product === "duckdb" && duckDBVersionSupport(version) === "supported";
  return defineDialectCapabilityStates(
    Object.fromEntries(
      Object.entries(DUCKDB_CAPABILITIES).map(([key, implemented]) => {
        const newOnly = ["backtickIdentifiers", "modifyingCtes", "nanosecondTimestampTZ"].includes(key);
        const unavailable = !implemented || (newOnly && version !== "2.0.0");
        return [
          key,
          {
            level: unavailable ? "unsupported" : supported ? "exact" : "conservative",
            reason: unavailable
              ? "This DuckDB feature is unavailable for the recorded engine and policy."
              : supported
                ? "Qualified DuckDB engine evidence is present."
                : "Exact support requires qualified DuckDB engine evidence.",
            ...(unavailable ? { diagnostic: "TSQ401" } : supported ? {} : { diagnostic: "TSQ402" }),
            evidence: [
              { kind: "grammar" as const, key: "grammarVersion", value: DUCKDB_DIALECT_VERSION },
              ...(version === "missing" ? [] : [{ kind: "server-version" as const, key: "duckdb", value: version }]),
            ],
          },
        ];
      }),
    ),
  );
}
