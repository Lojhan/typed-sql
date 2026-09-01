import {
  type DialectCapabilityEvidence,
  type DialectCapabilityState,
  type DialectCapabilityStates,
  type DialectServerEvidence,
  defineDialectCapabilityStates,
  defineDialectServerEvidence,
} from "@typed-sql/core";
import type { SqliteSchemaSnapshot } from "./snapshot.js";
import {
  compareSqliteVersions,
  parseSqliteVersion,
  SQLITE_LANGUAGE_SUPPORT,
  type SqliteVersion,
  sqliteVersionSupport,
} from "./support.js";
import { SQLITE_DIALECT_VERSION } from "./version.js";

export const SQLITE_CAPABILITIES = Object.freeze({
  aggregateFilter: true,
  arrays: false,
  distinctOn: false,
  fullJoins: true,
  lockingReads: false,
  recursiveCtes: true,
  returning: true,
  setOperations: true,
  strictTables: true,
});

type SqliteCapability = keyof typeof SQLITE_CAPABILITIES;
const versionGates = Object.freeze({
  aggregateFilter: "3.30.0",
  fullJoins: "3.39.0",
  recursiveCtes: "3.8.3",
  returning: "3.35.0",
  strictTables: "3.37.0",
} satisfies Partial<Record<SqliteCapability, string>>);

const unsupportedReasons: Readonly<Partial<Record<SqliteCapability, string>>> = Object.freeze({
  arrays: "SQLite has no native SQL array constructor or array value type.",
  distinctOn: "SQLite does not implement DISTINCT ON.",
  lockingReads: "SQLite does not implement row-level SELECT locking clauses.",
} satisfies Partial<Record<SqliteCapability, string>>);

export function assertSqliteServerEvidence(server: DialectServerEvidence): void {
  if (Object.keys(server.settings).length > 0) {
    throw new TypeError("SQLite server evidence does not allow semantic settings");
  }
  if (server.features.some((feature) => !/^[A-Z][A-Z0-9_]*(?:=.*)?$/u.test(feature))) {
    throw new TypeError("SQLite server features must be normalized compile options");
  }
}

export function sqliteServerEvidence(version: string, compileOptions: readonly string[] = []): DialectServerEvidence {
  const parsed = parseSqliteVersion(version);
  if (parsed === undefined) throw new TypeError(`Cannot normalize SQLite version ${JSON.stringify(version)}`);
  return defineDialectServerEvidence({
    product: "sqlite",
    version,
    versionKey: parsed.join("."),
    features: [...compileOptions],
    settings: {},
  });
}

function grammarEvidence(): DialectCapabilityEvidence {
  return Object.freeze({ kind: "grammar", key: "grammarVersion", value: SQLITE_DIALECT_VERSION });
}

function serverVersion(snapshot: SqliteSchemaSnapshot): { readonly text: string; readonly parsed?: SqliteVersion } {
  const text = snapshot.server?.versionKey ?? snapshot.version;
  if (text === undefined) return { text: "missing" };
  const parsed = parseSqliteVersion(text);
  return { text, ...(parsed === undefined ? {} : { parsed }) };
}

function serverFeatureEvidence(snapshot: SqliteSchemaSnapshot): DialectCapabilityEvidence[] {
  return (snapshot.server?.features ?? []).map((feature) => ({
    kind: "feature",
    key: feature,
    value: "present",
  }));
}

function capabilityState(capability: SqliteCapability, snapshot: SqliteSchemaSnapshot): DialectCapabilityState {
  const grammar = grammarEvidence();
  const server = snapshot.server;
  if (server !== undefined && server.product !== "sqlite") {
    return {
      level: "unsupported",
      reason: `${server.product} is not SQLite server evidence.`,
      diagnostic: "TSQ403",
      evidence: [grammar, { kind: "server-version", key: server.product, value: server.versionKey }],
    };
  }
  if (!SQLITE_CAPABILITIES[capability]) {
    return {
      level: "unsupported",
      reason: unsupportedReasons[capability] ?? "The SQLite grammar does not implement this feature.",
      diagnostic: "TSQ401",
      evidence: [grammar],
    };
  }
  const minimum = versionGates[capability as keyof typeof versionGates];
  const actual = serverVersion(snapshot);
  const evidence: DialectCapabilityEvidence[] = [grammar, ...serverFeatureEvidence(snapshot)];
  if (actual.text !== "missing") evidence.push({ kind: "server-version", key: "sqlite", value: actual.text });
  if (actual.parsed === undefined) {
    return {
      level: "conservative",
      reason: "Exact support requires normalized SQLite server-version evidence.",
      ...(minimum === undefined ? {} : { since: minimum }),
      diagnostic: "TSQ402",
      evidence,
    };
  }
  const support = sqliteVersionSupport(snapshot.server?.version ?? snapshot.version ?? actual.text);
  if (support === "prerelease") {
    return {
      level: "conservative",
      reason: "Pre-release SQLite versions require an explicit canary support policy.",
      ...(minimum === undefined ? {} : { since: minimum }),
      diagnostic: "TSQ403",
      evidence,
    };
  }
  if (capability === "aggregateFilter" && snapshot.server?.features.includes("OMIT_WINDOWFUNC") === true) {
    return {
      level: "unsupported",
      reason: "The SQLite library was compiled with OMIT_WINDOWFUNC, which removes aggregate FILTER syntax.",
      ...(minimum === undefined ? {} : { since: minimum }),
      diagnostic: "TSQ406",
      evidence,
    };
  }
  if (minimum !== undefined && compareSqliteVersions(actual.parsed, parseSqliteVersion(minimum)!) < 0) {
    return {
      level: "unsupported",
      reason: `SQLite ${minimum} or newer is required for this feature.`,
      since: minimum,
      diagnostic: "TSQ404",
      evidence,
    };
  }
  if (support === "below-supported" || support === "newer-than-tested") {
    return {
      level: "conservative",
      reason:
        support === "below-supported"
          ? `SQLite ${SQLITE_LANGUAGE_SUPPORT.minimum} is the minimum fully supported language baseline.`
          : `SQLite ${actual.text} is newer than the tested ${SQLITE_LANGUAGE_SUPPORT.maximum} ceiling.`,
      ...(minimum === undefined ? {} : { since: minimum }),
      diagnostic: "TSQ403",
      evidence,
    };
  }
  return {
    level: "exact",
    reason:
      minimum === undefined
        ? "The selected SQLite version is within the tested language support band."
        : `The selected SQLite version satisfies the ${minimum} feature boundary.`,
    ...(minimum === undefined ? {} : { since: minimum }),
    evidence,
  };
}

export function resolveSqliteCapabilities(snapshot: SqliteSchemaSnapshot): DialectCapabilityStates {
  if (snapshot.server !== undefined) assertSqliteServerEvidence(snapshot.server);
  const states = Object.fromEntries(
    (Object.keys(SQLITE_CAPABILITIES) as SqliteCapability[]).map((capability) => [
      capability,
      capabilityState(capability, snapshot),
    ]),
  );
  return defineDialectCapabilityStates(states, Object.keys(SQLITE_CAPABILITIES));
}

export { parseSqliteVersion } from "./support.js";
