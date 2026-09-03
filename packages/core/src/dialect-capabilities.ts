import { unknownQuerySemantics } from "./semantics.js";
import type { DialectAnalysis, SourceRange } from "./types.js";

export type DialectServerSetting = string | boolean | number;

/** Normalized, non-secret facts used by a grammar to select versioned behavior. */
export interface DialectServerEvidence {
  readonly product: string;
  /** Original, redacted version text exposed for diagnostics. */
  readonly version: string;
  /** Grammar-normalized version identity; only the owning grammar may compare it. */
  readonly versionKey: string;
  /** Sorted, non-secret extensions or compile capabilities. */
  readonly features: readonly string[];
  /** Sorted, allowlisted settings that materially change grammar semantics. */
  readonly settings: Readonly<Record<string, DialectServerSetting>>;
}

export type DialectCapabilityLevel = "exact" | "conservative" | "unsupported";
export type DialectCapabilityEvidenceKind = "server-version" | "feature" | "setting" | "policy" | "grammar";

export interface DialectCapabilityEvidence {
  readonly kind: DialectCapabilityEvidenceKind;
  readonly key: string;
  readonly value: string;
}

export interface DialectCapabilityState {
  readonly level: DialectCapabilityLevel;
  readonly reason: string;
  readonly since?: string;
  readonly until?: string;
  readonly diagnostic?: string;
  readonly evidence: readonly DialectCapabilityEvidence[];
}

export type DialectCapabilityStates = Readonly<Record<string, DialectCapabilityState>>;
export type BooleanDialectCapabilities = Readonly<Record<string, boolean>>;

export interface DialectCapabilityHost<Snapshot, Policy = unknown> {
  readonly grammarVersion: string;
  readonly capabilities: BooleanDialectCapabilities;
  readonly resolveCapabilities?: (snapshot: Snapshot, policy?: Policy) => DialectCapabilityStates;
}

export interface DialectCapabilityIssue {
  readonly capability: string;
  readonly state: DialectCapabilityState;
}

const capabilityPattern = /^[a-z][A-Za-z0-9]*$/u;
const diagnosticPattern = /^[A-Z][A-Z0-9]+$/u;
const secretSettingPattern = /(?:credential|databaseurl|dsn|password|secret|token)/iu;
const sensitiveValuePattern = /(?:[a-z][a-z0-9+.-]*:\/\/|(?:password|secret|token)\s*[=:])/iu;
const evidenceKinds = new Set<DialectCapabilityEvidenceKind>([
  "server-version",
  "feature",
  "setting",
  "policy",
  "grammar",
]);
const levels = new Set<DialectCapabilityLevel>(["exact", "conservative", "unsupported"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function artifactString(value: unknown, path: string, maximumLength = 1_000): string {
  const text = nonEmptyString(value, path);
  const unsafeControl = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
  if (text.length > maximumLength || unsafeControl) {
    throw new TypeError(`${path} is not safe artifact text`);
  }
  if (sensitiveValuePattern.test(text)) throw new TypeError(`${path} appears to contain secret connection material`);
  return text;
}

function sortedUniqueStrings(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${path} must be an array of non-empty strings`);
  }
  const strings = (value as string[]).map((item, index) => artifactString(item, `${path}[${index}]`));
  if (new Set(strings).size !== strings.length) throw new TypeError(`${path} must not contain duplicates`);
  return Object.freeze([...strings].sort());
}

function evidenceIdentity(value: DialectCapabilityEvidence): string {
  return `${value.kind}\0${value.key}\0${value.value}`;
}

function parseEvidence(value: unknown, path: string): DialectCapabilityEvidence {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  const unknown = Object.keys(value).filter((key) => !["kind", "key", "value"].includes(key));
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown properties: ${unknown.sort().join(", ")}`);
  if (typeof value.kind !== "string" || !evidenceKinds.has(value.kind as DialectCapabilityEvidenceKind)) {
    throw new TypeError(`${path}.kind is not a supported capability evidence kind`);
  }
  return Object.freeze({
    kind: value.kind as DialectCapabilityEvidenceKind,
    key: artifactString(value.key, `${path}.key`, 200),
    value: artifactString(value.value, `${path}.value`),
  });
}

function parseCapabilityState(value: unknown, path: string): DialectCapabilityState {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  const unknown = Object.keys(value).filter(
    (key) => !["level", "reason", "since", "until", "diagnostic", "evidence"].includes(key),
  );
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown properties: ${unknown.sort().join(", ")}`);
  if (typeof value.level !== "string" || !levels.has(value.level as DialectCapabilityLevel)) {
    throw new TypeError(`${path}.level must be exact, conservative, or unsupported`);
  }
  const level = value.level as DialectCapabilityLevel;
  const reason = artifactString(value.reason, `${path}.reason`);
  const since = value.since === undefined ? undefined : nonEmptyString(value.since, `${path}.since`);
  const until = value.until === undefined ? undefined : nonEmptyString(value.until, `${path}.until`);
  if (since !== undefined && until !== undefined && since === until) {
    throw new TypeError(`${path} cannot use the same since and until version`);
  }
  const diagnostic =
    value.diagnostic === undefined ? undefined : nonEmptyString(value.diagnostic, `${path}.diagnostic`);
  if (diagnostic !== undefined && !diagnosticPattern.test(diagnostic)) {
    throw new TypeError(`${path}.diagnostic must be a stable uppercase diagnostic code`);
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    throw new TypeError(`${path}.evidence must contain at least one item`);
  }
  const evidence = value.evidence.map((item, index) => parseEvidence(item, `${path}.evidence[${index}]`));
  const identities = evidence.map(evidenceIdentity);
  if (new Set(identities).size !== identities.length)
    throw new TypeError(`${path}.evidence must not contain duplicates`);
  evidence.sort((left, right) => evidenceIdentity(left).localeCompare(evidenceIdentity(right)));
  return Object.freeze({
    level,
    reason,
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
    evidence: Object.freeze(evidence),
  });
}

/** Parses, canonicalizes, and deeply freezes normalized server evidence. */
export function parseDialectServerEvidence(value: unknown): DialectServerEvidence {
  if (!isRecord(value)) throw new TypeError("Dialect server evidence must be an object");
  const unknown = Object.keys(value).filter(
    (key) => !["product", "version", "versionKey", "features", "settings"].includes(key),
  );
  if (unknown.length > 0) {
    throw new TypeError(`Dialect server evidence contains unknown properties: ${unknown.sort().join(", ")}`);
  }
  const product = artifactString(value.product, "server.product", 100);
  const version = artifactString(value.version, "server.version", 500);
  const versionKey = artifactString(value.versionKey, "server.versionKey", 200);
  const features = sortedUniqueStrings(value.features, "server.features");
  if (!isRecord(value.settings)) throw new TypeError("server.settings must be an object");
  const settings: Record<string, DialectServerSetting> = {};
  for (const key of Object.keys(value.settings).sort()) {
    if (key.length === 0) throw new TypeError("server.settings keys must be non-empty");
    if (secretSettingPattern.test(key.replaceAll(/[^A-Za-z]/gu, ""))) {
      throw new TypeError(`server.settings.${key} appears to contain secret connection material`);
    }
    const setting = value.settings[key];
    if (typeof setting !== "string" && typeof setting !== "boolean" && typeof setting !== "number") {
      throw new TypeError(`server.settings.${key} must be a string, boolean, or number`);
    }
    if (typeof setting === "number" && !Number.isFinite(setting)) {
      throw new TypeError(`server.settings.${key} must be finite`);
    }
    if (typeof setting === "string") artifactString(setting || "<empty>", `server.settings.${key}`);
    settings[key] = setting;
  }
  return Object.freeze({
    product,
    version,
    versionKey,
    features,
    settings: Object.freeze(settings),
  });
}

export function defineDialectServerEvidence(value: DialectServerEvidence): DialectServerEvidence {
  return parseDialectServerEvidence(value);
}

/** Validates, canonicalizes, and deeply freezes grammar-owned capability states. */
export function defineDialectCapabilityStates(
  value: DialectCapabilityStates,
  declaredCapabilities: readonly string[] = Object.keys(value),
): DialectCapabilityStates {
  if (!isRecord(value)) throw new TypeError("Dialect capability states must be an object");
  const declared = sortedUniqueStrings(declaredCapabilities, "declaredCapabilities");
  for (const capability of declared) {
    if (!capabilityPattern.test(capability)) {
      throw new TypeError(`declared capability ${capability} must be a lower camel-case identifier`);
    }
  }
  const actual = Object.keys(value).sort();
  if (actual.length !== declared.length || actual.some((capability, index) => capability !== declared[index])) {
    throw new TypeError("Dialect capability states must exactly match declared capabilities");
  }
  const states: Record<string, DialectCapabilityState> = {};
  for (const capability of actual) {
    if (!capabilityPattern.test(capability)) {
      throw new TypeError(`capability ${capability} must be a lower camel-case identifier`);
    }
    states[capability] = parseCapabilityState(value[capability], `capabilities.${capability}`);
  }
  return Object.freeze(states);
}

/**
 * Migration helper for grammar capabilities whose support does not vary inside the declared
 * server-version range. Version-sensitive features should use a grammar-owned resolver instead.
 */
export function staticDialectCapabilityStates(
  capabilities: BooleanDialectCapabilities,
  grammarVersion: string,
  server?: DialectServerEvidence,
  unsupportedDiagnostic = "TSQ401",
  additionalEvidence: readonly DialectCapabilityEvidence[] = [],
): DialectCapabilityStates {
  const grammar = nonEmptyString(grammarVersion, "grammarVersion");
  const normalizedServer = server === undefined ? undefined : parseDialectServerEvidence(server);
  if (!diagnosticPattern.test(unsupportedDiagnostic)) {
    throw new TypeError("unsupportedDiagnostic must be a stable uppercase diagnostic code");
  }
  const names = Object.keys(capabilities).sort();
  const evidence: DialectCapabilityEvidence[] = [
    { kind: "grammar", key: "grammarVersion", value: grammar },
    ...(normalizedServer === undefined
      ? []
      : [
          {
            kind: "server-version" as const,
            key: normalizedServer.product,
            value: normalizedServer.versionKey,
          },
        ]),
    ...additionalEvidence,
  ];
  return defineDialectCapabilityStates(
    Object.fromEntries(
      names.map((capability) => [
        capability,
        capabilities[capability]
          ? {
              level: normalizedServer === undefined ? "conservative" : "exact",
              reason:
                normalizedServer === undefined
                  ? "The grammar implements this feature, but exact support requires normalized server evidence."
                  : "The grammar implements this feature throughout its declared support range.",
              ...(normalizedServer === undefined ? { diagnostic: "TSQ402" } : {}),
              evidence,
            }
          : {
              level: "unsupported",
              reason: "This grammar version does not implement the feature.",
              diagnostic: unsupportedDiagnostic,
              evidence,
            },
      ]),
    ),
    names,
  );
}

/**
 * Resolves the additive state contract and verifies that its compatibility view agrees with the
 * existing boolean declaration. Third-party v4 grammars receive conservative migration states.
 */
export function resolveDialectCapabilityStates<Snapshot, Policy = unknown>(
  dialect: DialectCapabilityHost<Snapshot, Policy>,
  snapshot: Snapshot,
  policy?: Policy,
): DialectCapabilityStates {
  if (isRecord(snapshot) && snapshot.server !== undefined) parseDialectServerEvidence(snapshot.server);
  const names = Object.keys(dialect.capabilities).sort();
  const resolved =
    dialect.resolveCapabilities?.(snapshot, policy) ??
    Object.fromEntries(
      names.map((capability) => {
        const supported = dialect.capabilities[capability] === true;
        return [
          capability,
          {
            level: supported ? "conservative" : "unsupported",
            reason: supported
              ? "Legacy boolean capability has not supplied exact version evidence."
              : "Legacy boolean capability declares this feature unsupported.",
            evidence: [{ kind: "grammar", key: "grammarVersion", value: dialect.grammarVersion }],
          },
        ];
      }),
    );
  const states = defineDialectCapabilityStates(resolved, names);
  for (const capability of names) {
    const supported = states[capability]?.level !== "unsupported";
    if (supported && dialect.capabilities[capability] !== true) {
      throw new TypeError(`Capability ${capability} state exceeds its boolean compatibility declaration`);
    }
  }
  return states;
}

/**
 * Finds capability requirements that cannot be used exactly. Undeclared requirements fail closed
 * with a stable condition diagnostic instead of being treated as implicitly supported.
 */
export function dialectCapabilityIssues(
  requiredCapabilities: readonly string[],
  states: DialectCapabilityStates,
): readonly DialectCapabilityIssue[] {
  const issues = [...new Set(requiredCapabilities)].sort().flatMap((capability): DialectCapabilityIssue[] => {
    const state = states[capability];
    if (state !== undefined && state.level === "exact") return [];
    if (state !== undefined) return [{ capability, state }];
    return [
      {
        capability,
        state: Object.freeze({
          level: "unsupported",
          reason: `The grammar did not declare capability ${capability}.`,
          diagnostic: "TSQ406",
          evidence: Object.freeze([Object.freeze({ kind: "policy" as const, key: "declaration", value: "missing" })]),
        }),
      },
    ];
  });
  return Object.freeze(issues.map((issue) => Object.freeze(issue)));
}

/** Applies unsupported declared capability states to one grammar analysis result. */
export function applyDialectCapabilityStates(
  analysis: DialectAnalysis,
  states: DialectCapabilityStates,
  range: SourceRange,
): DialectAnalysis {
  const unsupported = [...new Set(analysis.semantics.capabilities)].sort().flatMap((capability) => {
    const state = states[capability];
    return state?.level === "unsupported" ? [{ capability, state }] : [];
  });
  if (unsupported.length === 0) return analysis;
  return {
    ...analysis,
    diagnostics: [
      ...analysis.diagnostics,
      ...unsupported.map(({ capability, state }) => ({
        code: state.diagnostic ?? "TSQ401",
        message: `${capability}: ${state.reason}`,
        range,
        severity: "error" as const,
        suggestion: "Regenerate the schema snapshot or choose SQL supported by its recorded server evidence.",
      })),
    ],
    semantics: unknownQuerySemantics(range, "A required SQL capability is unsupported by the recorded server."),
  };
}
