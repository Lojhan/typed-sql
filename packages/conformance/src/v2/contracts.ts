import type { GrammarFeatureLedger } from "../feature-ledger.js";
import {
  CONFORMANCE_VERSION,
  type ConformanceProbe,
  type ConformanceSuite,
  type ConformanceTarget,
  type ConformanceTargetSelector,
  type ExpectedOutcome,
} from "./types.js";

const probeIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)+$/u;
const featureIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)+$/u;
const repositoryPathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)[a-zA-Z0-9_.@/-]+$/u;

function freeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function validateSelector(selector: ConformanceTargetSelector, label: string): void {
  if (
    selector.databaseVersion !== undefined &&
    (selector.minimumDatabaseVersion !== undefined || selector.maximumDatabaseVersion !== undefined)
  ) {
    throw new TypeError(`${label} cannot combine an exact database version with a version range`);
  }
  if (
    selector.minimumDatabaseVersion !== undefined &&
    selector.maximumDatabaseVersion !== undefined &&
    selector.minimumDatabaseVersion.localeCompare(selector.maximumDatabaseVersion, undefined, { numeric: true }) > 0
  ) {
    throw new TypeError(`${label} has an inverted database version range`);
  }
}

export function defineConformanceProbe(probe: ConformanceProbe): ConformanceProbe {
  if (probe.version !== CONFORMANCE_VERSION) throw new TypeError("Unsupported conformance probe version");
  if (!probeIdPattern.test(probe.id)) throw new TypeError(`Invalid conformance probe id ${JSON.stringify(probe.id)}`);
  if (!featureIdPattern.test(probe.featureId))
    throw new TypeError(`Invalid feature id ${JSON.stringify(probe.featureId)}`);
  if (probe.grammar.length === 0) throw new TypeError("Conformance probe grammar must not be empty");
  if (probe.source.length === 0) throw new TypeError("Conformance probe SQL must not be empty");
  if (!repositoryPathPattern.test(probe.schemaFixture)) throw new TypeError("schemaFixture must be a repository path");
  if (probe.targets.length === 0 || probe.expected.length === 0) {
    throw new TypeError("Conformance probes require targets and expected outcomes");
  }
  for (const [index, target] of probe.targets.entries()) {
    if (target.grammar !== probe.grammar) throw new TypeError(`${probe.id}.targets[${index}] uses another grammar`);
  }
  for (const [index, outcome] of probe.expected.entries())
    validateSelector(outcome.target, `${probe.id}.expected[${index}]`);
  if (probe.quarantine !== undefined && Date.parse(probe.quarantine.expires) <= Date.now()) {
    throw new TypeError(`${probe.id} quarantine expired`);
  }
  return freeze({ ...probe });
}

export function defineConformanceSuite(suite: ConformanceSuite, ledger?: GrammarFeatureLedger): ConformanceSuite {
  if (suite.version !== CONFORMANCE_VERSION) throw new TypeError("Unsupported conformance suite version");
  if (suite.name.length === 0) throw new TypeError("Conformance suite name must not be empty");
  const probes = suite.probes.map(defineConformanceProbe);
  if (new Set(probes.map(({ id }) => id)).size !== probes.length)
    throw new TypeError("Conformance probe IDs must be unique");
  if (ledger !== undefined) {
    const features = new Set(ledger.entries.map(({ id }) => id));
    for (const probe of probes) {
      if (!features.has(probe.featureId))
        throw new TypeError(`${probe.id} references unknown feature ${probe.featureId}`);
    }
  }
  return freeze({ ...suite, probes });
}

function capabilitiesMatch(
  required: ConformanceTargetSelector["capabilities"],
  actual: ConformanceTarget["capabilities"],
): boolean {
  if (required === undefined) return true;
  return Object.entries(required).every(([name, value]) => actual?.[name] === value);
}

export function targetMatches(selector: ConformanceTargetSelector, target: ConformanceTarget): boolean {
  if (selector.grammarVersion !== undefined && selector.grammarVersion !== target.grammarVersion) return false;
  if (selector.databaseVersion !== undefined && selector.databaseVersion !== target.databaseVersion) return false;
  if (
    selector.minimumDatabaseVersion !== undefined &&
    (target.databaseVersion === undefined ||
      target.databaseVersion.localeCompare(selector.minimumDatabaseVersion, undefined, { numeric: true }) < 0)
  ) {
    return false;
  }
  if (
    selector.maximumDatabaseVersion !== undefined &&
    (target.databaseVersion === undefined ||
      target.databaseVersion.localeCompare(selector.maximumDatabaseVersion, undefined, { numeric: true }) > 0)
  ) {
    return false;
  }
  return capabilitiesMatch(selector.capabilities, target.capabilities);
}

export function selectExpectedOutcome(probe: ConformanceProbe, target: ConformanceTarget): ExpectedOutcome {
  const matches = probe.expected.filter(({ target: selector }) => targetMatches(selector, target));
  if (matches.length !== 1) {
    throw new TypeError(
      `${probe.id} expected exactly one outcome for ${target.grammar}@${target.databaseVersion ?? "static"}`,
    );
  }
  return matches[0]!;
}
