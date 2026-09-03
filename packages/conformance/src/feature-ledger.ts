export const FEATURE_LEDGER_FORMAT_VERSION = 1 as const;

export type GrammarFeatureCategory =
  | "lexical"
  | "statement"
  | "clause"
  | "expression"
  | "operator"
  | "function-family"
  | "type-family"
  | "coercion"
  | "semantic"
  | "schema"
  | "runtime"
  | "tooling";

export type GrammarFeatureScope = "application-query" | "conservative-command" | "out-of-scope";
export type GrammarFeatureSupportLevel = "exact" | "conservative" | "unsupported" | "out-of-scope";
export type GrammarVersionScheme = "major" | "major-minor" | "numeric";

export interface GrammarVersionRange {
  readonly minimum: string;
  readonly maximum: string;
}

export interface GrammarDialectPolicy {
  readonly title: string;
  readonly versionScheme: GrammarVersionScheme;
  readonly stable: readonly GrammarVersionRange[];
  readonly canary: readonly GrammarVersionRange[];
  readonly sources: readonly GrammarFeatureSource[];
}

export interface GrammarFeatureSource {
  readonly title: string;
  readonly url: string;
  readonly vendorVersion?: string;
}

export interface GrammarFeatureSupport {
  readonly level: GrammarFeatureSupportLevel;
  readonly introduced?: string;
  readonly removed?: string;
  readonly conditions?: readonly string[];
  readonly diagnostic?: string;
  readonly tests: readonly string[];
  readonly notes?: string;
}

export interface GrammarFeatureEntry {
  /** Permanent, globally unique feature identity. */
  readonly id: string;
  readonly title: string;
  readonly category: GrammarFeatureCategory;
  readonly scope: GrammarFeatureScope;
  /** Package or repository area accountable for keeping the classification current. */
  readonly owner: string;
  /** Existing dialect capability key during the boolean-capability migration. */
  readonly capability?: string;
  /** Stable implementation-surface identities covered by this entry. */
  readonly coverage: readonly string[];
  /** Public pages whose support statements are checked against this entry. */
  readonly documentation: readonly string[];
  readonly sources: readonly GrammarFeatureSource[];
  readonly dialects: Readonly<Record<string, GrammarFeatureSupport>>;
}

export interface GrammarFeatureLedger {
  readonly formatVersion: typeof FEATURE_LEDGER_FORMAT_VERSION;
  readonly dialects: Readonly<Record<string, GrammarDialectPolicy>>;
  readonly entries: readonly GrammarFeatureEntry[];
}

const categories = new Set<GrammarFeatureCategory>([
  "lexical",
  "statement",
  "clause",
  "expression",
  "operator",
  "function-family",
  "type-family",
  "coercion",
  "semantic",
  "schema",
  "runtime",
  "tooling",
]);
const scopes = new Set<GrammarFeatureScope>(["application-query", "conservative-command", "out-of-scope"]);
const levels = new Set<GrammarFeatureSupportLevel>(["exact", "conservative", "unsupported", "out-of-scope"]);
const featureIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)+$/u;
const capabilityPattern = /^[a-z][A-Za-z0-9]*$/u;
const dialectPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const diagnosticPattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;
const ownerPattern = /^(?:repository|@typed-sql\/[a-z][a-z0-9-]*)$/u;
const coveragePattern = /^(?:ast|diagnostic|docs|resolver|runtime|schema|tooling):[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const repositoryPathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)[a-zA-Z0-9_.@/-]+$/u;
const versionPattern = /^\d+(?:\.\d+){0,2}$/u;
const versionSchemes = new Set<GrammarVersionScheme>(["major", "major-minor", "numeric"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown properties: ${unknown.sort().join(", ")}`);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new TypeError(`${path} must be a trimmed, non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, path);
}

function sortedUniqueStrings(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${path} must be an array of non-empty strings`);
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) throw new TypeError(`${path} must not contain duplicates`);
  const sorted = [...strings].sort();
  if (strings.some((item, index) => item !== sorted[index])) throw new TypeError(`${path} must be sorted`);
  return Object.freeze([...strings]);
}

function repositoryPaths(value: unknown, path: string, prefix: string): readonly string[] {
  const paths = sortedUniqueStrings(value, path);
  for (const item of paths) {
    if (!repositoryPathPattern.test(item) || !item.startsWith(prefix)) {
      throw new TypeError(`${path} entries must be canonical ${prefix} repository paths`);
    }
  }
  return paths;
}

function parseSource(value: unknown, path: string): GrammarFeatureSource {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  assertOnlyKeys(value, ["title", "url", "vendorVersion"], path);
  const title = nonEmptyString(value.title, `${path}.title`);
  const url = nonEmptyString(value.url, `${path}.url`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`${path}.url must be an absolute URL`);
  }
  if (parsed.protocol !== "https:") throw new TypeError(`${path}.url must use HTTPS`);
  const vendorVersion = optionalString(value.vendorVersion, `${path}.vendorVersion`);
  return Object.freeze({ title, url, ...(vendorVersion === undefined ? {} : { vendorVersion }) });
}

function parseSources(value: unknown, path: string): readonly GrammarFeatureSource[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${path} must contain at least one authoritative source`);
  }
  const sources = value.map((source, index) => parseSource(source, `${path}[${index}]`));
  const sourceUrls = sources.map(({ url }) => url);
  if (new Set(sourceUrls).size !== sourceUrls.length) throw new TypeError(`${path} must not repeat URLs`);
  return Object.freeze([...sources].sort((left, right) => left.url.localeCompare(right.url)));
}

function versionParts(value: string, scheme: GrammarVersionScheme): readonly number[] {
  if (!versionPattern.test(value)) throw new TypeError(`Invalid ${scheme} version ${JSON.stringify(value)}`);
  const parts = value.split(".").map(Number);
  if (scheme === "major") return [parts[0]!];
  if (scheme === "major-minor") return [parts[0]!, parts[1] ?? 0];
  return [parts[0]!, parts[1] ?? 0, parts[2] ?? 0];
}

/** Compares canonical vendor versions according to that vendor's release-line semantics. */
export function compareGrammarVersions(left: string, right: string, scheme: GrammarVersionScheme): number {
  const leftParts = versionParts(left, scheme);
  const rightParts = versionParts(right, scheme);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function grammarVersionInRange(
  version: string,
  range: GrammarVersionRange,
  scheme: GrammarVersionScheme,
): boolean {
  return (
    compareGrammarVersions(version, range.minimum, scheme) >= 0 &&
    compareGrammarVersions(version, range.maximum, scheme) <= 0
  );
}

function parseVersionRange(value: unknown, path: string, scheme: GrammarVersionScheme): GrammarVersionRange {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  assertOnlyKeys(value, ["minimum", "maximum"], path);
  const minimum = nonEmptyString(value.minimum, `${path}.minimum`);
  const maximum = nonEmptyString(value.maximum, `${path}.maximum`);
  versionParts(minimum, scheme);
  versionParts(maximum, scheme);
  if (compareGrammarVersions(minimum, maximum, scheme) > 0) {
    throw new TypeError(`${path}.minimum must not be newer than ${path}.maximum`);
  }
  return Object.freeze({ minimum, maximum });
}

function parseRanges(value: unknown, path: string, scheme: GrammarVersionScheme): readonly GrammarVersionRange[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const ranges = value.map((range, index) => parseVersionRange(range, `${path}[${index}]`, scheme));
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1]!;
    const current = ranges[index]!;
    if (compareGrammarVersions(previous.minimum, current.minimum, scheme) >= 0) {
      throw new TypeError(`${path} must be sorted by minimum version without duplicates`);
    }
    if (compareGrammarVersions(previous.maximum, current.minimum, scheme) >= 0) {
      throw new TypeError(`${path} must not contain overlapping ranges`);
    }
  }
  return Object.freeze(ranges);
}

function parseDialectPolicy(value: unknown, path: string): GrammarDialectPolicy {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  assertOnlyKeys(value, ["title", "versionScheme", "stable", "canary", "sources"], path);
  const title = nonEmptyString(value.title, `${path}.title`);
  if (typeof value.versionScheme !== "string" || !versionSchemes.has(value.versionScheme as GrammarVersionScheme)) {
    throw new TypeError(`${path}.versionScheme is not supported`);
  }
  const versionScheme = value.versionScheme as GrammarVersionScheme;
  const stable = parseRanges(value.stable, `${path}.stable`, versionScheme);
  if (stable.length === 0) throw new TypeError(`${path}.stable must contain at least one supported range`);
  const canary = parseRanges(value.canary, `${path}.canary`, versionScheme);
  for (const canaryRange of canary) {
    if (
      stable.some(
        (stableRange) =>
          compareGrammarVersions(canaryRange.maximum, stableRange.minimum, versionScheme) >= 0 &&
          compareGrammarVersions(canaryRange.minimum, stableRange.maximum, versionScheme) <= 0,
      )
    ) {
      throw new TypeError(`${path}.canary must not overlap stable ranges`);
    }
  }
  const sources = parseSources(value.sources, `${path}.sources`);
  return Object.freeze({ title, versionScheme, stable, canary, sources });
}

function parseSupport(value: unknown, path: string, scheme: GrammarVersionScheme): GrammarFeatureSupport {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  assertOnlyKeys(value, ["level", "introduced", "removed", "conditions", "diagnostic", "tests", "notes"], path);
  if (typeof value.level !== "string" || !levels.has(value.level as GrammarFeatureSupportLevel)) {
    throw new TypeError(`${path}.level must be exact, conservative, unsupported, or out-of-scope`);
  }
  const level = value.level as GrammarFeatureSupportLevel;
  const introduced = optionalString(value.introduced, `${path}.introduced`);
  const removed = optionalString(value.removed, `${path}.removed`);
  if (introduced !== undefined) versionParts(introduced, scheme);
  if (removed !== undefined) versionParts(removed, scheme);
  if (introduced !== undefined && removed !== undefined && compareGrammarVersions(introduced, removed, scheme) >= 0) {
    throw new TypeError(`${path}.introduced must be older than ${path}.removed`);
  }
  const conditions =
    value.conditions === undefined ? undefined : sortedUniqueStrings(value.conditions, `${path}.conditions`);
  const diagnostic = optionalString(value.diagnostic, `${path}.diagnostic`);
  if (diagnostic !== undefined && !diagnosticPattern.test(diagnostic)) {
    throw new TypeError(`${path}.diagnostic must be a stable uppercase diagnostic code`);
  }
  if (level === "unsupported" && diagnostic === undefined) {
    throw new TypeError(`${path}.diagnostic is required for unsupported support`);
  }
  const tests = sortedUniqueStrings(value.tests, `${path}.tests`);
  if (tests.length === 0) {
    throw new TypeError(`${path}.tests must prove the ${level} classification`);
  }
  for (const test of tests) {
    if (!repositoryPathPattern.test(test) || !test.includes("/test/") || !test.endsWith(".test.ts")) {
      throw new TypeError(`${path}.tests entries must be canonical executable test paths`);
    }
  }
  const notes = optionalString(value.notes, `${path}.notes`);
  return Object.freeze({
    level,
    ...(introduced === undefined ? {} : { introduced }),
    ...(removed === undefined ? {} : { removed }),
    ...(conditions === undefined ? {} : { conditions }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
    tests,
    ...(notes === undefined ? {} : { notes }),
  });
}

function parseEntry(
  value: unknown,
  path: string,
  policies: Readonly<Record<string, GrammarDialectPolicy>>,
): GrammarFeatureEntry {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  assertOnlyKeys(
    value,
    ["id", "title", "category", "scope", "owner", "capability", "coverage", "documentation", "sources", "dialects"],
    path,
  );
  const id = nonEmptyString(value.id, `${path}.id`);
  if (!featureIdPattern.test(id)) throw new TypeError(`${path}.id is not a canonical feature id`);
  const title = nonEmptyString(value.title, `${path}.title`);
  if (typeof value.category !== "string" || !categories.has(value.category as GrammarFeatureCategory)) {
    throw new TypeError(`${path}.category is not supported`);
  }
  const category = value.category as GrammarFeatureCategory;
  if (typeof value.scope !== "string" || !scopes.has(value.scope as GrammarFeatureScope)) {
    throw new TypeError(`${path}.scope is not supported`);
  }
  const scope = value.scope as GrammarFeatureScope;
  const owner = nonEmptyString(value.owner, `${path}.owner`);
  if (!ownerPattern.test(owner)) throw new TypeError(`${path}.owner is not a package or repository owner`);
  const capability = optionalString(value.capability, `${path}.capability`);
  if (capability !== undefined && !capabilityPattern.test(capability)) {
    throw new TypeError(`${path}.capability must be a lower camel-case identifier`);
  }
  const coverage = sortedUniqueStrings(value.coverage, `${path}.coverage`);
  if (coverage.length === 0) throw new TypeError(`${path}.coverage must not be empty`);
  for (const token of coverage) {
    if (!coveragePattern.test(token)) throw new TypeError(`${path}.coverage contains invalid token ${token}`);
  }
  const documentation = repositoryPaths(value.documentation, `${path}.documentation`, "docs/");
  if (documentation.length === 0) throw new TypeError(`${path}.documentation must not be empty`);
  const sources = parseSources(value.sources, `${path}.sources`);
  if (!isRecord(value.dialects) || Object.keys(value.dialects).length === 0) {
    throw new TypeError(`${path}.dialects must contain at least one grammar`);
  }
  const dialectNames = Object.keys(value.dialects);
  const policyNames = Object.keys(policies);
  if (dialectNames.length !== policyNames.length || dialectNames.some((name, index) => name !== policyNames[index])) {
    throw new TypeError(`${path}.dialects must classify every configured grammar: ${policyNames.join(", ")}`);
  }
  const sortedDialectNames = [...dialectNames].sort();
  if (dialectNames.some((name, index) => name !== sortedDialectNames[index])) {
    throw new TypeError(`${path}.dialects must be sorted`);
  }
  const dialects: Record<string, GrammarFeatureSupport> = {};
  for (const dialect of dialectNames) {
    if (!dialectPattern.test(dialect)) throw new TypeError(`${path}.dialects.${dialect} is not a canonical grammar id`);
    dialects[dialect] = parseSupport(
      value.dialects[dialect],
      `${path}.dialects.${dialect}`,
      policies[dialect]!.versionScheme,
    );
  }
  return Object.freeze({
    id,
    title,
    category,
    scope,
    owner,
    ...(capability === undefined ? {} : { capability }),
    coverage,
    documentation,
    sources,
    dialects: Object.freeze(dialects),
  });
}

/** Parses, validates, canonicalizes, and deeply freezes a feature ledger. */
export function parseGrammarFeatureLedger(value: unknown): GrammarFeatureLedger {
  if (!isRecord(value)) throw new TypeError("Grammar feature ledger must be an object");
  assertOnlyKeys(value, ["formatVersion", "dialects", "entries"], "ledger");
  if (value.formatVersion !== FEATURE_LEDGER_FORMAT_VERSION) {
    throw new TypeError(`Unsupported grammar feature ledger format ${String(value.formatVersion)}`);
  }
  if (!isRecord(value.dialects) || Object.keys(value.dialects).length === 0) {
    throw new TypeError("ledger.dialects must contain at least one grammar support policy");
  }
  const dialectNames = Object.keys(value.dialects);
  const sortedDialectNames = [...dialectNames].sort();
  if (dialectNames.some((name, index) => name !== sortedDialectNames[index])) {
    throw new TypeError("ledger.dialects must be sorted");
  }
  const dialects: Record<string, GrammarDialectPolicy> = {};
  for (const dialect of dialectNames) {
    if (!dialectPattern.test(dialect)) throw new TypeError(`ledger.dialects.${dialect} is not a canonical grammar id`);
    dialects[dialect] = parseDialectPolicy(value.dialects[dialect], `ledger.dialects.${dialect}`);
  }
  if (!Array.isArray(value.entries)) throw new TypeError("ledger.entries must be an array");
  const entries = value.entries.map((entry, index) => parseEntry(entry, `ledger.entries[${index}]`, dialects));
  const ids = entries.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new TypeError("ledger.entries must have unique feature ids");
  const sortedIds = [...ids].sort();
  if (ids.some((id, index) => id !== sortedIds[index])) throw new TypeError("ledger.entries must be sorted by id");
  const capabilityIds = entries.flatMap(({ capability }) => (capability === undefined ? [] : [capability]));
  if (new Set(capabilityIds).size !== capabilityIds.length) {
    throw new TypeError("ledger.entries must map each compatibility capability at most once");
  }
  const coverage = entries.flatMap((entry) => entry.coverage);
  if (new Set(coverage).size !== coverage.length) {
    throw new TypeError("ledger.entries must map each implementation coverage token exactly once");
  }
  return Object.freeze({
    formatVersion: FEATURE_LEDGER_FORMAT_VERSION,
    dialects: Object.freeze(dialects),
    entries: Object.freeze(entries),
  });
}

export function defineGrammarFeatureLedger(value: GrammarFeatureLedger): GrammarFeatureLedger {
  return parseGrammarFeatureLedger(value);
}

export function featureSupport(
  ledger: GrammarFeatureLedger,
  featureId: string,
  dialect: string,
): GrammarFeatureSupport | undefined {
  const entry = ledger.entries.find(({ id }) => id === featureId);
  return entry?.dialects[dialect];
}

/** Resolves a feature classification for a concrete server version, failing closed outside its version window. */
export function featureSupportAtVersion(
  ledger: GrammarFeatureLedger,
  featureId: string,
  dialect: string,
  version: string,
): GrammarFeatureSupport | undefined {
  const support = featureSupport(ledger, featureId, dialect);
  const policy = ledger.dialects[dialect];
  if (support === undefined || policy === undefined) return undefined;
  if (
    support.introduced !== undefined &&
    compareGrammarVersions(version, support.introduced, policy.versionScheme) < 0
  ) {
    return undefined;
  }
  if (support.removed !== undefined && compareGrammarVersions(version, support.removed, policy.versionScheme) >= 0) {
    return undefined;
  }
  return support;
}
