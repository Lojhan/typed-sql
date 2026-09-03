import { createHash } from "node:crypto";
import type {
  QueryPlanBudget,
  QueryPlanBudgetPolicy,
  QueryPlanEnvironment,
  QueryPlanEvidence,
  QueryPlanInspector,
  QueryPlanNode,
  QueryPlanSampleProvider,
} from "@typed-sql/core";
import {
  parseQueryManifest,
  type QueryManifest,
  type QueryManifestEntry,
  type QueryManifestLocation,
  type QueryManifestVariant,
  serializeQueryManifest,
} from "./manifest.js";
import type { QueryVerificationCandidate } from "./verification.js";

export const QUERY_PLAN_FORMAT_VERSION = 1 as const;
export const QUERY_PLAN_CAPTURE_VERSION = "typed-sql-v1" as const;
export const QUERY_PLAN_REVIEW_FORMAT_VERSION = 1 as const;

interface QueryPlanEntryBase {
  readonly queryId: string;
  readonly variantFingerprint?: string;
  readonly source: QueryManifestLocation;
}

export interface CapturedQueryPlanEntry extends QueryPlanEntryBase {
  readonly variantFingerprint: string;
  readonly status: "captured";
  readonly sampleFingerprint?: string;
  readonly evidence: QueryPlanEvidence;
}

export interface SkippedQueryPlanEntry extends QueryPlanEntryBase {
  readonly status: "skipped";
  readonly reason:
    | "manifest-unresolved"
    | "candidate-missing"
    | "unsafe-operation"
    | "parameters-required"
    | "sample-count-mismatch";
}

export interface FailedQueryPlanEntry extends QueryPlanEntryBase {
  readonly variantFingerprint: string;
  readonly status: "error";
  readonly reason: "plan-capture-failed" | "sample-provider-failed";
}

export type QueryPlanEntry = CapturedQueryPlanEntry | SkippedQueryPlanEntry | FailedQueryPlanEntry;

export interface QueryPlanArtifact {
  readonly formatVersion: typeof QUERY_PLAN_FORMAT_VERSION;
  readonly captureVersion: typeof QUERY_PLAN_CAPTURE_VERSION;
  readonly adapterVersion: string;
  readonly parameterMode: QueryPlanInspector["parameterMode"];
  readonly dialect: string;
  readonly manifestHash: string;
  readonly schemaFormat?: 1 | 2;
  readonly schemaHash: string;
  readonly captureKey: string;
  readonly environment: QueryPlanEnvironment;
  readonly entries: readonly QueryPlanEntry[];
}

export interface CaptureQueryPlansOptions {
  readonly manifest: QueryManifest;
  readonly candidates: readonly QueryVerificationCandidate[];
  readonly inspector: QueryPlanInspector;
  readonly sampleValues?: QueryPlanSampleProvider;
  readonly concurrency?: number;
}

export interface CaptureQueryPlansResult {
  readonly artifact: QueryPlanArtifact;
  readonly captured: number;
  readonly skipped: number;
  readonly failed: number;
}

export type QueryPlanComparisonReason =
  | "dialect-changed"
  | "server-version-changed"
  | "schema-changed"
  | "settings-changed"
  | "statistics-changed"
  | "sample-changed"
  | "baseline-query-missing"
  | "baseline-query-unavailable";

const queryPlanComparisonReasons = new Set<QueryPlanComparisonReason>([
  "dialect-changed",
  "server-version-changed",
  "schema-changed",
  "settings-changed",
  "statistics-changed",
  "sample-changed",
  "baseline-query-missing",
  "baseline-query-unavailable",
]);

export type QueryPlanViolationKind =
  | "total-cost"
  | "estimated-rows"
  | "total-cost-increase"
  | "estimated-rows-increase"
  | "required-node-missing"
  | "forbidden-node-present";

const queryPlanViolationKinds = new Set<QueryPlanViolationKind>([
  "total-cost",
  "estimated-rows",
  "total-cost-increase",
  "estimated-rows-increase",
  "required-node-missing",
  "forbidden-node-present",
]);

export interface QueryPlanViolation {
  readonly kind: QueryPlanViolationKind;
  readonly expected: string;
  readonly actual: string;
}

export interface QueryPlanReviewEntry {
  readonly queryId: string;
  readonly variantFingerprint?: string;
  readonly source: QueryManifestLocation;
  readonly status: "pass" | "violation" | "incomparable" | "unavailable" | "unbudgeted";
  readonly reasons: readonly QueryPlanComparisonReason[];
  readonly violations: readonly QueryPlanViolation[];
}

export interface QueryPlanReviewReport {
  readonly formatVersion: typeof QUERY_PLAN_REVIEW_FORMAT_VERSION;
  readonly captureKey: string;
  readonly baselineCaptureKey?: string;
  readonly environmentReasons: readonly QueryPlanComparisonReason[];
  readonly entries: readonly QueryPlanReviewEntry[];
  readonly summary: Readonly<Record<QueryPlanReviewEntry["status"], number>>;
}

export interface ReviewQueryPlansOptions {
  readonly current: QueryPlanArtifact;
  readonly baseline?: QueryPlanArtifact;
  readonly budgets?: QueryPlanBudgetPolicy;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function manifestHash(manifest: QueryManifest): string {
  return `sha256:${sha256(serializeQueryManifest(manifest))}`;
}

function normalizedEnvironment(value: QueryPlanEnvironment): QueryPlanEnvironment {
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new TypeError("Plan environment version must be a non-empty string");
  }
  if (!/^sha256:[a-f\d]{64}$/u.test(value.statisticsFingerprint)) {
    throw new TypeError("Plan environment statisticsFingerprint must be a SHA-256 fingerprint");
  }
  const settings = Object.fromEntries(
    Object.entries(value.settings)
      .map(([name, setting]) => {
        if (name.length === 0 || typeof setting !== "string") {
          throw new TypeError("Plan environment settings must contain string names and values");
        }
        return [name, setting] as const;
      })
      .sort(([left], [right]) => compareText(left, right)),
  );
  return { version: value.version, settings, statisticsFingerprint: value.statisticsFingerprint };
}

function normalizedEvidence(value: QueryPlanEvidence): QueryPlanEvidence {
  const metric = (input: number | undefined, description: string) => {
    if (input !== undefined && (!Number.isFinite(input) || input < 0)) {
      throw new TypeError(`${description} must be a non-negative finite number`);
    }
    return input;
  };
  if (!Array.isArray(value.nodes)) throw new TypeError("Plan evidence nodes must be an array");
  const nodes = value.nodes.map((node, index): QueryPlanNode => {
    if (typeof node.kind !== "string" || node.kind.length === 0) {
      throw new TypeError(`Plan node ${index}.kind must be a non-empty string`);
    }
    for (const property of ["relation", "index"] as const) {
      if (node[property] !== undefined && (typeof node[property] !== "string" || node[property].length === 0)) {
        throw new TypeError(`Plan node ${index}.${property} must be a non-empty string`);
      }
    }
    return {
      kind: node.kind,
      ...(node.relation === undefined ? {} : { relation: node.relation }),
      ...(node.index === undefined ? {} : { index: node.index }),
      ...(metric(node.estimatedRows, `Plan node ${index}.estimatedRows`) === undefined
        ? {}
        : { estimatedRows: node.estimatedRows }),
      ...(metric(node.estimatedCost, `Plan node ${index}.estimatedCost`) === undefined
        ? {}
        : { estimatedCost: node.estimatedCost }),
    };
  });
  return {
    ...(metric(value.totalCost, "Plan totalCost") === undefined ? {} : { totalCost: value.totalCost }),
    ...(metric(value.estimatedRows, "Plan estimatedRows") === undefined ? {} : { estimatedRows: value.estimatedRows }),
    nodes,
  };
}

async function boundedMap<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  visit: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const output = new Array<Output>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await visit(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(values.length, concurrency) }, worker));
  return output;
}

function captureKey(value: Omit<QueryPlanArtifact, "captureKey">): string {
  return `sha256:${sha256(JSON.stringify(canonicalize(value)))}`;
}

export async function captureQueryPlans(options: CaptureQueryPlansOptions): Promise<CaptureQueryPlansResult> {
  parseQueryManifest(options.manifest);
  if (options.inspector.dialect !== options.manifest.dialect.id) {
    throw new TypeError(`Plan inspector dialect ${options.inspector.dialect} does not match the manifest`);
  }
  if (typeof options.inspector.adapterVersion !== "string" || options.inspector.adapterVersion.length === 0) {
    throw new TypeError("Plan inspector adapterVersion must be a non-empty string");
  }
  if (!(options.inspector.parameterMode === "value-free" || options.inspector.parameterMode === "samples-required")) {
    throw new TypeError("Plan inspector parameterMode is unsupported");
  }
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("Plan capture concurrency must be a positive safe integer");
  }
  const candidates = new Map(
    options.candidates.map(
      (candidate) => [`${candidate.queryId}\0${candidate.variantFingerprint}`, candidate] as const,
    ),
  );
  const pending: { readonly entry: QueryManifestEntry; readonly variant?: QueryManifestVariant }[] = [];
  for (const entry of options.manifest.queries) {
    if (entry.status === "unresolved") pending.push({ entry });
    else for (const variant of entry.variants) pending.push({ entry, variant });
  }
  const entries = [
    ...(await boundedMap(pending, concurrency, async (item): Promise<QueryPlanEntry> => {
      if (item.entry.status === "unresolved") {
        return { queryId: item.entry.id, source: item.entry.source, status: "skipped", reason: "manifest-unresolved" };
      }
      const variant = item.variant;
      if (variant === undefined) throw new TypeError("Resolved manifest entry is missing a plan variant");
      const variantFingerprint = variant.fingerprint;
      const base = { queryId: item.entry.id, variantFingerprint, source: item.entry.source };
      const candidate = candidates.get(`${item.entry.id}\0${variantFingerprint}`);
      if (candidate === undefined) return { ...base, status: "skipped", reason: "candidate-missing" };
      if (!(candidate.operation === "read" || candidate.operation === "write")) {
        return { ...base, status: "skipped", reason: "unsafe-operation" };
      }
      let sample: Awaited<ReturnType<QueryPlanSampleProvider>>;
      try {
        sample = await options.sampleValues?.({
          queryId: candidate.queryId,
          variantFingerprint,
          source: candidate.source,
          parameters: candidate.parameters,
        });
      } catch {
        return { ...base, status: "error", reason: "sample-provider-failed" };
      }
      if (sample !== undefined && (typeof sample.identity !== "string" || sample.identity.length === 0)) {
        throw new TypeError("Plan sample identity must be a non-empty string");
      }
      if (sample !== undefined && sample.values.length !== candidate.parameters.length) {
        return { ...base, status: "skipped", reason: "sample-count-mismatch" };
      }
      if (
        candidate.parameters.length > 0 &&
        sample === undefined &&
        options.inspector.parameterMode === "samples-required"
      ) {
        return { ...base, status: "skipped", reason: "parameters-required" };
      }
      try {
        const evidence = normalizedEvidence(
          await options.inspector.capture({
            fingerprint: variantFingerprint,
            sql: candidate.sql,
            operation: candidate.operation,
            parameterCount: candidate.parameters.length,
            ...(sample === undefined ? {} : { values: sample.values }),
          }),
        );
        return {
          ...base,
          status: "captured",
          ...(sample === undefined ? {} : { sampleFingerprint: `sha256:${sha256(sample.identity)}` }),
          evidence,
        };
      } catch {
        return { ...base, status: "error", reason: "plan-capture-failed" };
      }
    })),
  ];
  entries.sort(
    (left, right) =>
      compareText(left.source.file, right.source.file) ||
      left.source.range.start - right.source.range.start ||
      compareText(left.variantFingerprint ?? "", right.variantFingerprint ?? ""),
  );
  const withoutKey: Omit<QueryPlanArtifact, "captureKey"> = {
    formatVersion: QUERY_PLAN_FORMAT_VERSION,
    captureVersion: QUERY_PLAN_CAPTURE_VERSION,
    adapterVersion: options.inspector.adapterVersion,
    parameterMode: options.inspector.parameterMode,
    dialect: options.inspector.dialect,
    manifestHash: manifestHash(options.manifest),
    ...(options.manifest.schemaFormat === undefined ? {} : { schemaFormat: options.manifest.schemaFormat }),
    schemaHash: options.manifest.schemaHash,
    environment: normalizedEnvironment(await options.inspector.environment()),
    entries,
  };
  const artifact: QueryPlanArtifact = { ...withoutKey, captureKey: captureKey(withoutKey) };
  return {
    artifact,
    captured: entries.filter((entry) => entry.status === "captured").length,
    skipped: entries.filter((entry) => entry.status === "skipped").length,
    failed: entries.filter((entry) => entry.status === "error").length,
  };
}

function mergeBudget(defaults: QueryPlanBudget | undefined, specific: QueryPlanBudget | undefined) {
  return defaults === undefined && specific === undefined ? undefined : { ...defaults, ...specific };
}

function compareEnvironment(current: QueryPlanArtifact, baseline: QueryPlanArtifact): QueryPlanComparisonReason[] {
  const reasons: QueryPlanComparisonReason[] = [];
  if (current.dialect !== baseline.dialect) reasons.push("dialect-changed");
  if (current.environment.version !== baseline.environment.version) reasons.push("server-version-changed");
  if (current.schemaFormat !== baseline.schemaFormat || current.schemaHash !== baseline.schemaHash) {
    reasons.push("schema-changed");
  }
  if (JSON.stringify(current.environment.settings) !== JSON.stringify(baseline.environment.settings)) {
    reasons.push("settings-changed");
  }
  if (current.environment.statisticsFingerprint !== baseline.environment.statisticsFingerprint) {
    reasons.push("statistics-changed");
  }
  return reasons;
}

function violations(
  current: CapturedQueryPlanEntry,
  baseline: CapturedQueryPlanEntry | undefined,
  budget: QueryPlanBudget,
  comparable: boolean,
): QueryPlanViolation[] {
  const values: QueryPlanViolation[] = [];
  const maximum = (kind: QueryPlanViolationKind, actual: number | undefined, expected: number | undefined) => {
    if (actual !== undefined && expected !== undefined && actual > expected) {
      values.push({ kind, expected: `<= ${expected}`, actual: String(actual) });
    }
  };
  maximum("total-cost", current.evidence.totalCost, budget.maximumTotalCost);
  maximum("estimated-rows", current.evidence.estimatedRows, budget.maximumEstimatedRows);
  const ratio = (
    kind: QueryPlanViolationKind,
    actual: number | undefined,
    previous: number | undefined,
    expected: number | undefined,
  ) => {
    if (comparable && actual !== undefined && previous !== undefined && previous > 0 && expected !== undefined) {
      const value = actual / previous;
      if (value > expected) values.push({ kind, expected: `<= ${expected}`, actual: String(value) });
    }
  };
  ratio(
    "total-cost-increase",
    current.evidence.totalCost,
    baseline?.evidence.totalCost,
    budget.maximumTotalCostIncreaseRatio,
  );
  ratio(
    "estimated-rows-increase",
    current.evidence.estimatedRows,
    baseline?.evidence.estimatedRows,
    budget.maximumEstimatedRowsIncreaseRatio,
  );
  const nodeKinds = new Set(current.evidence.nodes.map((node) => node.kind));
  for (const kind of budget.requiredNodeKinds ?? []) {
    if (!nodeKinds.has(kind)) values.push({ kind: "required-node-missing", expected: kind, actual: "missing" });
  }
  for (const kind of budget.forbiddenNodeKinds ?? []) {
    if (nodeKinds.has(kind)) values.push({ kind: "forbidden-node-present", expected: "absent", actual: kind });
  }
  return values;
}

export function reviewQueryPlans(options: ReviewQueryPlansOptions): QueryPlanReviewReport {
  const environmentReasons =
    options.baseline === undefined ? [] : compareEnvironment(options.current, options.baseline);
  const baselineEntries = new Map(
    (options.baseline?.entries ?? [])
      .filter((entry) => entry.variantFingerprint !== undefined)
      .map((entry) => [entry.variantFingerprint!, entry]),
  );
  const entries: QueryPlanReviewEntry[] = options.current.entries.map((entry) => {
    const budget =
      entry.variantFingerprint === undefined
        ? options.budgets?.defaults
        : mergeBudget(options.budgets?.defaults, options.budgets?.queries?.[entry.variantFingerprint]);
    if (entry.status !== "captured") {
      return { ...entry, status: "unavailable", reasons: [], violations: [] };
    }
    if (budget === undefined) return { ...entry, status: "unbudgeted", reasons: [], violations: [] };
    const baselineEntry = baselineEntries.get(entry.variantFingerprint);
    const baseline = baselineEntry?.status === "captured" ? baselineEntry : undefined;
    const reasons = [...environmentReasons];
    if (options.baseline !== undefined && baselineEntry === undefined) reasons.push("baseline-query-missing");
    else if (baselineEntry !== undefined && baseline === undefined) reasons.push("baseline-query-unavailable");
    else if (baseline !== undefined && baseline.sampleFingerprint !== entry.sampleFingerprint) {
      reasons.push("sample-changed");
    }
    const needsBaseline =
      budget.maximumTotalCostIncreaseRatio !== undefined || budget.maximumEstimatedRowsIncreaseRatio !== undefined;
    if (needsBaseline && options.baseline === undefined) reasons.push("baseline-query-missing");
    const comparable = reasons.length === 0 && baseline !== undefined;
    const failures = violations(entry, baseline, budget, comparable);
    return {
      queryId: entry.queryId,
      variantFingerprint: entry.variantFingerprint,
      source: entry.source,
      status: failures.length > 0 ? "violation" : needsBaseline && !comparable ? "incomparable" : "pass",
      reasons,
      violations: failures,
    };
  });
  const summary = {
    pass: entries.filter((entry) => entry.status === "pass").length,
    violation: entries.filter((entry) => entry.status === "violation").length,
    incomparable: entries.filter((entry) => entry.status === "incomparable").length,
    unavailable: entries.filter((entry) => entry.status === "unavailable").length,
    unbudgeted: entries.filter((entry) => entry.status === "unbudgeted").length,
  };
  return {
    formatVersion: QUERY_PLAN_REVIEW_FORMAT_VERSION,
    captureKey: options.current.captureKey,
    ...(options.baseline === undefined ? {} : { baselineCaptureKey: options.baseline.captureKey }),
    environmentReasons,
    entries,
    summary,
  };
}

export function serializeQueryPlanArtifact(artifact: QueryPlanArtifact): string {
  return `${JSON.stringify(canonicalize(artifact), null, 2)}\n`;
}

export function serializeQueryPlanReviewReport(report: QueryPlanReviewReport): string {
  return `${JSON.stringify(canonicalize(report), null, 2)}\n`;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fingerprint(value: unknown, description: string, prefixed = true): asserts value is string {
  const expression = prefixed ? /^sha256:[a-f\d]{64}$/u : /^[a-f\d]{64}$/u;
  if (typeof value !== "string" || !expression.test(value)) {
    throw new TypeError(`${description} must be a SHA-256 fingerprint`);
  }
}

function location(value: unknown, description: string): asserts value is QueryManifestLocation {
  if (!record(value) || typeof value.file !== "string" || value.file.length === 0 || !record(value.range)) {
    throw new TypeError(`${description} must contain a relative file and range`);
  }
  if (value.file.startsWith("/") || value.file.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(value.file)) {
    throw new TypeError(`${description}.file must be relative`);
  }
  for (const property of ["start", "end", "line", "column"] as const) {
    if (!Number.isSafeInteger(value.range[property]) || (value.range[property] as number) < 0) {
      throw new TypeError(`${description}.range.${property} must be a non-negative safe integer`);
    }
  }
}

export function parseQueryPlanArtifact(value: unknown): QueryPlanArtifact {
  if (!record(value)) throw new TypeError("Query plan artifact must be an object");
  const artifact = value;
  if (artifact.formatVersion !== QUERY_PLAN_FORMAT_VERSION) {
    throw new TypeError(`Unsupported query plan artifact format ${String(artifact.formatVersion)}`);
  }
  if (artifact.captureVersion !== QUERY_PLAN_CAPTURE_VERSION) {
    throw new TypeError(`Unsupported query plan capture version ${String(artifact.captureVersion)}`);
  }
  for (const property of ["adapterVersion", "dialect"] as const) {
    if (typeof artifact[property] !== "string" || artifact[property].length === 0) {
      throw new TypeError(`Query plan artifact ${property} must be a non-empty string`);
    }
  }
  if (!(artifact.parameterMode === "value-free" || artifact.parameterMode === "samples-required")) {
    throw new TypeError("Query plan artifact parameterMode is unsupported");
  }
  fingerprint(artifact.manifestHash, "Query plan artifact manifestHash");
  if (artifact.schemaFormat !== undefined && artifact.schemaFormat !== 1 && artifact.schemaFormat !== 2) {
    throw new TypeError("Query plan artifact schemaFormat must be 1 or 2");
  }
  fingerprint(artifact.schemaHash, "Query plan artifact schemaHash", false);
  fingerprint(artifact.captureKey, "Query plan artifact captureKey");
  if (!record(artifact.environment)) throw new TypeError("Query plan artifact environment must be an object");
  normalizedEnvironment(artifact.environment as unknown as QueryPlanEnvironment);
  if (!Array.isArray(artifact.entries)) throw new TypeError("Query plan artifact entries must be an array");
  const skippedReasons = new Set<SkippedQueryPlanEntry["reason"]>([
    "manifest-unresolved",
    "candidate-missing",
    "unsafe-operation",
    "parameters-required",
    "sample-count-mismatch",
  ]);
  for (const [index, entry] of artifact.entries.entries()) {
    if (!record(entry)) throw new TypeError(`Query plan artifact entry ${index} must be an object`);
    fingerprint(entry.queryId, `Query plan artifact entry ${index}.queryId`);
    location(entry.source, `Query plan artifact entry ${index}.source`);
    if (entry.variantFingerprint !== undefined) {
      fingerprint(entry.variantFingerprint, `Query plan artifact entry ${index}.variantFingerprint`);
    }
    if (entry.status === "captured") {
      fingerprint(entry.variantFingerprint, `Captured query plan entry ${index}.variantFingerprint`);
      if (entry.sampleFingerprint !== undefined) {
        fingerprint(entry.sampleFingerprint, `Captured query plan entry ${index}.sampleFingerprint`);
      }
      if (!record(entry.evidence)) throw new TypeError(`Captured query plan entry ${index}.evidence is invalid`);
      normalizedEvidence(entry.evidence as unknown as QueryPlanEvidence);
    } else if (entry.status === "skipped") {
      if (!skippedReasons.has(entry.reason as SkippedQueryPlanEntry["reason"])) {
        throw new TypeError(`Skipped query plan entry ${index}.reason is unsupported`);
      }
    } else if (entry.status === "error") {
      fingerprint(entry.variantFingerprint, `Failed query plan entry ${index}.variantFingerprint`);
      if (!(entry.reason === "plan-capture-failed" || entry.reason === "sample-provider-failed")) {
        throw new TypeError(`Failed query plan entry ${index}.reason is unsupported`);
      }
    } else throw new TypeError(`Query plan artifact entry ${index}.status is unsupported`);
  }
  const { captureKey: actual, ...withoutKey } = artifact;
  if (actual !== captureKey(withoutKey as Omit<QueryPlanArtifact, "captureKey">)) {
    throw new TypeError("Query plan artifact captureKey does not match its canonical evidence");
  }
  return value as unknown as QueryPlanArtifact;
}

export function parseQueryPlanReviewReport(value: unknown): QueryPlanReviewReport {
  if (!record(value)) throw new TypeError("Query plan review report must be an object");
  if (value.formatVersion !== QUERY_PLAN_REVIEW_FORMAT_VERSION) {
    throw new TypeError(`Unsupported query plan review format ${String(value.formatVersion)}`);
  }
  fingerprint(value.captureKey, "Query plan review captureKey");
  if (value.baselineCaptureKey !== undefined)
    fingerprint(value.baselineCaptureKey, "Query plan review baselineCaptureKey");
  if (!Array.isArray(value.environmentReasons) || !Array.isArray(value.entries) || !record(value.summary)) {
    throw new TypeError("Query plan review environmentReasons, entries, or summary are invalid");
  }
  if (value.environmentReasons.some((reason) => !queryPlanComparisonReasons.has(reason as QueryPlanComparisonReason))) {
    throw new TypeError("Query plan review environmentReasons contain an unsupported reason");
  }
  const statuses = ["pass", "violation", "incomparable", "unavailable", "unbudgeted"] as const;
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<(typeof statuses)[number], number>;
  for (const [index, entry] of value.entries.entries()) {
    if (!record(entry) || !statuses.includes(entry.status as (typeof statuses)[number])) {
      throw new TypeError(`Query plan review entry ${index} is invalid`);
    }
    fingerprint(entry.queryId, `Query plan review entry ${index}.queryId`);
    if (entry.variantFingerprint !== undefined) {
      fingerprint(entry.variantFingerprint, `Query plan review entry ${index}.variantFingerprint`);
    }
    location(entry.source, `Query plan review entry ${index}.source`);
    if (!Array.isArray(entry.reasons) || !Array.isArray(entry.violations)) {
      throw new TypeError(`Query plan review entry ${index} reasons and violations must be arrays`);
    }
    if (entry.reasons.some((reason) => !queryPlanComparisonReasons.has(reason as QueryPlanComparisonReason))) {
      throw new TypeError(`Query plan review entry ${index} contains an unsupported reason`);
    }
    for (const violation of entry.violations) {
      if (
        !record(violation) ||
        !queryPlanViolationKinds.has(violation.kind as QueryPlanViolationKind) ||
        typeof violation.expected !== "string" ||
        typeof violation.actual !== "string"
      ) {
        throw new TypeError(`Query plan review entry ${index} contains an invalid violation`);
      }
    }
    counts[entry.status as (typeof statuses)[number]] += 1;
  }
  for (const status of statuses) {
    if (value.summary[status] !== counts[status]) throw new TypeError(`Query plan review summary.${status} is invalid`);
  }
  return value as unknown as QueryPlanReviewReport;
}
