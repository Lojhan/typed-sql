import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { compileSource } from "@typed-sql/compiler";
import { type Query, renderQuery, type SchemaSnapshot, type SourceRange } from "@typed-sql/core";
import { selectExpectedOutcome } from "./contracts.js";
import {
  CONFORMANCE_REPORT_FORMAT_VERSION,
  CONFORMANCE_VERSION,
  type ConformanceDifference,
  type ConformanceEnvironment,
  type ConformanceLayer,
  type ConformanceLayerResult,
  type ConformanceLiveAdapter,
  type ConformanceLiveRequest,
  type ConformancePreparedEvidence,
  type ConformanceProbe,
  type ConformanceProbeResult,
  type ConformanceReport,
  type ConformanceSkipReason,
  type ConformanceStaticContext,
  type ConformanceTarget,
  type ConformanceTypeNormalizer,
  type ExpectedColumn,
  type ExpectedDiagnostic,
  type ExpectedOutcome,
  type ExpectedParameter,
} from "./types.js";

const allLayers = Object.freeze([
  "lex-parse",
  "resolve",
  "compile",
  "render",
  "prepare",
  "execute",
  "plan",
] as const satisfies readonly ConformanceLayer[]);

class ConformanceTimeoutError extends Error {
  override readonly name = "ConformanceTimeoutError";
}

async function withinTimeout<Value>(operation: Promise<Value>, milliseconds: number): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ConformanceTimeoutError(`Conformance layer exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validatePreparedEvidence(value: ConformancePreparedEvidence): ConformancePreparedEvidence {
  if (typeof value !== "object" || value === null) throw new TypeError("Prepared evidence must be an object");
  for (const [kind, fields] of [
    ["columns", value.columns],
    ["parameters", value.parameters],
  ] as const) {
    if (!Array.isArray(fields)) throw new TypeError(`Prepared evidence ${kind} must be an array`);
    for (const [offset, field] of fields.entries()) {
      if (typeof field !== "object" || field === null)
        throw new TypeError(`Prepared evidence ${kind}[${offset}] must be an object`);
      if (!Number.isSafeInteger(field.index) || field.index < 1) {
        throw new TypeError(`Prepared evidence ${kind}[${offset}].index must be a positive integer`);
      }
      if (field.name !== undefined && (typeof field.name !== "string" || field.name.length === 0)) {
        throw new TypeError(`Prepared evidence ${kind}[${offset}].name must be a non-empty string`);
      }
      if (field.nativeType !== undefined && (typeof field.nativeType !== "string" || field.nativeType.length === 0)) {
        throw new TypeError(`Prepared evidence ${kind}[${offset}].nativeType must be a non-empty string`);
      }
      if (field.nullable !== undefined && typeof field.nullable !== "boolean") {
        throw new TypeError(`Prepared evidence ${kind}[${offset}].nullable must be boolean`);
      }
    }
  }
  return value;
}

function liveErrorClass(error: unknown, adapter: ConformanceLiveAdapter) {
  return error instanceof ConformanceTimeoutError ? "timeout" : adapter.classify(error);
}

function freeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function difference(path: string, expected: unknown, actual: unknown): readonly ConformanceDifference[] {
  return isDeepStrictEqual(expected, actual) ? [] : [Object.freeze({ path, expected, actual })];
}

function sensitiveDifference(path: string, expected: unknown, actual: unknown): readonly ConformanceDifference[] {
  return isDeepStrictEqual(expected, actual)
    ? []
    : [Object.freeze({ path, expected: "[redacted]", actual: "[redacted]" })];
}

function omitUndefined(value: object): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function columns(value: readonly ExpectedColumn[] | undefined): readonly Readonly<Record<string, unknown>>[] {
  return (value ?? []).map((column) => omitUndefined(column));
}

function resolvedColumns(
  value: readonly {
    readonly name: string;
    readonly tsType: string;
    readonly nullable: boolean;
    readonly databaseType?: string;
    readonly range: SourceRange;
  }[],
): readonly Readonly<Record<string, unknown>>[] {
  return value.map(({ name, tsType, nullable, databaseType, range }) =>
    omitUndefined({ name, tsType, nullable, databaseType, range }),
  );
}

function parameters(value: readonly ExpectedParameter[] | undefined): readonly Readonly<Record<string, unknown>>[] {
  return (value ?? []).map((parameter) => omitUndefined(parameter));
}

function diagnostics(value: readonly ExpectedDiagnostic[] | undefined): readonly ExpectedDiagnostic[] {
  return value ?? [];
}

function liveColumns(value: readonly ExpectedColumn[] | undefined): readonly Readonly<Record<string, unknown>>[] {
  return (value ?? []).map(({ range: _range, ...column }) => omitUndefined(column));
}

function layerResult(
  layer: ConformanceLayer,
  started: number,
  differences: readonly ConformanceDifference[] = [],
): ConformanceLayerResult {
  return freeze({
    layer,
    status: differences.length === 0 ? "pass" : "fail",
    durationMilliseconds: performance.now() - started,
    ...(differences.length === 0 ? {} : { differences }),
  });
}

function skipped(layer: ConformanceLayer, reason: ConformanceSkipReason): ConformanceLayerResult {
  return Object.freeze({ layer, status: "skip", durationMilliseconds: 0, skipReason: reason });
}

function failed(layer: ConformanceLayer, started: number, error: unknown): ConformanceLayerResult {
  return layerResult(layer, started, [
    Object.freeze({
      path: `${layer}.error`,
      expected: "no error",
      actual: error instanceof ConformanceTimeoutError ? "operation timed out" : "[redacted adapter error]",
    }),
  ]);
}

function outcomeStatus(
  probe: ConformanceProbe,
  layers: readonly ConformanceLayerResult[],
): ConformanceProbeResult["status"] {
  if (probe.quarantine !== undefined) return "quarantined";
  if (layers.some(({ status }) => status === "fail")) return "fail";
  if (layers.every(({ status }) => status === "skip")) return "skip";
  return "pass";
}

function createProbeResult(
  probe: ConformanceProbe,
  target: ConformanceTarget,
  outcome: ExpectedOutcome,
  layers: readonly ConformanceLayerResult[],
): ConformanceProbeResult {
  return freeze({
    probeId: probe.id,
    featureId: probe.featureId,
    target,
    support: outcome.support,
    status: outcomeStatus(probe, layers),
    layers,
  });
}

function explicitSkip(outcome: ExpectedOutcome, layer: ConformanceLayer): ConformanceLayerResult | undefined {
  const reason = outcome.skips?.[layer];
  return reason === undefined ? undefined : skipped(layer, reason);
}

export function runStaticConformanceProbe<Snapshot extends SchemaSnapshot, Policy>(
  probe: ConformanceProbe,
  target: ConformanceTarget,
  context: ConformanceStaticContext<Snapshot, Policy>,
): ConformanceProbeResult {
  if (target.grammar !== probe.grammar || context.dialect.id !== probe.grammar) {
    throw new TypeError(`${probe.id} cannot run against grammar ${context.dialect.id}`);
  }
  const outcome = selectExpectedOutcome(probe, target);
  const layers: ConformanceLayerResult[] = [];

  const parseSkip = explicitSkip(outcome, "lex-parse");
  if (parseSkip !== undefined) layers.push(parseSkip);
  else if (context.parse === undefined) layers.push(skipped("lex-parse", "grammar-parser-private"));
  else {
    const started = performance.now();
    try {
      const parsed = context.parse(probe.source);
      const parsedDiagnostics = parsed.diagnostics.map(({ code, severity, range }) => ({ code, severity, range }));
      const differences = [...difference("lex-parse.diagnostics", diagnostics(outcome.diagnostics), parsedDiagnostics)];
      if (
        parsed.ast !== undefined &&
        (typeof parsed.ast !== "object" || parsed.ast === null || !Object.isFrozen(parsed.ast))
      ) {
        differences.push(Object.freeze({ path: "lex-parse.ast", expected: "immutable AST", actual: "mutable AST" }));
      }
      layers.push(layerResult("lex-parse", started, differences));
    } catch (error) {
      layers.push(failed("lex-parse", started, error));
    }
  }

  const resolveSkip = explicitSkip(outcome, "resolve");
  if (resolveSkip !== undefined) layers.push(resolveSkip);
  else {
    const started = performance.now();
    try {
      const analysis = context.dialect.analyze(probe.source, context.snapshot, context.policy);
      const actualColumns = resolvedColumns(analysis.columns);
      const actualParameters = analysis.parameters.map((parameter) => omitUndefined(parameter));
      const actualDiagnostics = analysis.diagnostics.map(({ code, severity, range }) => ({ code, severity, range }));
      const differences = [
        ...difference("resolve.rows", columns(outcome.rows), actualColumns),
        ...difference("resolve.parameters", parameters(outcome.parameters), actualParameters),
        ...difference("resolve.diagnostics", diagnostics(outcome.diagnostics), actualDiagnostics),
        ...difference("resolve.resultKind", outcome.resultKind ?? "rows", analysis.resultKind ?? "rows"),
      ];
      layers.push(layerResult("resolve", started, differences));
    } catch (error) {
      layers.push(failed("resolve", started, error));
    }
  }

  const compileSkip = explicitSkip(outcome, "compile");
  if (compileSkip !== undefined) layers.push(compileSkip);
  else if (probe.compilerSource === undefined) layers.push(skipped("compile", "no-compiler-source"));
  else {
    const started = performance.now();
    try {
      const compiled = compileSource({
        source: probe.compilerSource,
        dialect: context.dialect,
        schema: context.snapshot,
        typePolicy: context.policy,
      });
      const query = compiled.queries[0];
      const compiledDiagnostics = compiled.diagnostics.map(({ code, severity, range }) => ({ code, severity, range }));
      const differences = [
        ...difference("compile.diagnostics", diagnostics(outcome.diagnostics), compiledDiagnostics),
        ...difference("compile.queryCount", outcome.compiled === undefined ? 0 : 1, compiled.queries.length),
      ];
      if (outcome.compiled !== undefined && query !== undefined) {
        differences.push(...difference("compile.rowType", outcome.compiled.rowType, query.rowType));
        differences.push(...difference("compile.parameterType", outcome.compiled.parameterType, query.parameterType));
        if (outcome.compiled.fingerprint !== undefined) {
          differences.push(...difference("compile.fingerprint", outcome.compiled.fingerprint, query.fingerprint));
        }
      }
      layers.push(layerResult("compile", started, differences));
    } catch (error) {
      layers.push(failed("compile", started, error));
    }
  }

  const renderSkip = explicitSkip(outcome, "render");
  if (renderSkip !== undefined) layers.push(renderSkip);
  else if (probe.query === undefined || outcome.rendered === undefined)
    layers.push(skipped("render", "no-runtime-query"));
  else {
    const started = performance.now();
    try {
      const rendered = renderQuery(probe.query as Query<unknown, readonly unknown[]>, context.renderer);
      const differences = [
        ...difference("render.text", outcome.rendered.text, rendered.text),
        ...sensitiveDifference("render.values", outcome.rendered.values, rendered.values),
      ];
      layers.push(layerResult("render", started, differences));
    } catch (error) {
      layers.push(failed("render", started, error));
    }
  }

  for (const layer of ["prepare", "execute", "plan"] as const) {
    layers.push(explicitSkip(outcome, layer) ?? skipped(layer, "no-live-adapter"));
  }
  return createProbeResult(probe, target, outcome, layers);
}

function statementCount(source: string): number {
  let count = 1;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote !== undefined) {
      if (character === quote && source[index + 1] === quote) index += 1;
      else if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === ";" && source.slice(index + 1).trim().length > 0) count += 1;
  }
  return count;
}

function assertSafeLiveProbe(probe: ConformanceProbe, outcome: ExpectedOutcome): ConformanceLiveRequest {
  if (probe.source.length > 1_000_000) throw new RangeError(`${probe.id} exceeds the live SQL size limit`);
  if (statementCount(probe.source) > 1 && probe.live?.allowMultipleStatements !== true) {
    throw new TypeError(`${probe.id} contains multiple live statements`);
  }
  if (!/^\s*(?:SELECT|WITH|EXPLAIN)\b/iu.test(probe.source) && probe.live?.allowMutation !== true) {
    throw new TypeError(`${probe.id} must explicitly allow live mutation`);
  }
  const values = outcome.rendered?.values ?? [];
  if (values.length > 65_535) throw new RangeError(`${probe.id} exceeds the live parameter limit`);
  return Object.freeze({
    probeId: probe.id,
    sql: outcome.rendered?.text ?? probe.source,
    values,
    timeoutMilliseconds: probe.live?.timeoutMilliseconds ?? 5_000,
  });
}

export async function runLiveConformanceProbe(
  probe: ConformanceProbe,
  target: ConformanceTarget,
  adapter: ConformanceLiveAdapter,
  normalizer: ConformanceTypeNormalizer,
  staticResult?: ConformanceProbeResult,
): Promise<ConformanceProbeResult> {
  if (adapter.grammar !== probe.grammar) throw new TypeError(`${probe.id} cannot use ${adapter.grammar} live adapter`);
  const outcome = selectExpectedOutcome(probe, target);
  const request = assertSafeLiveProbe(probe, outcome);
  const layers = staticResult?.layers.filter(({ layer }) => !["prepare", "execute", "plan"].includes(layer)) ?? [];
  try {
    if (probe.live?.prepare === true) {
      const started = performance.now();
      try {
        const evidence = validatePreparedEvidence(
          await withinTimeout(adapter.prepare(request), request.timeoutMilliseconds),
        );
        const differences = [
          ...difference("prepare.rows", liveColumns(outcome.rows), evidence.columns.map(normalizer.column)),
          ...difference(
            "prepare.parameters",
            parameters(outcome.parameters),
            evidence.parameters.map(normalizer.parameter),
          ),
        ];
        layers.push(layerResult("prepare", started, differences));
      } catch (error) {
        layers.push(freeze({ ...failed("prepare", started, error), errorClass: liveErrorClass(error, adapter) }));
      }
    } else layers.push(explicitSkip(outcome, "prepare") ?? skipped("prepare", "no-server-metadata"));

    if (probe.live?.execute === true) {
      const started = performance.now();
      try {
        const rows = await withinTimeout(adapter.execute(request), request.timeoutMilliseconds);
        const maximumRows = probe.live.maximumRows ?? 1_000;
        const differences = [
          ...(rows.length > maximumRows
            ? [Object.freeze({ path: "execute.rowCount", expected: `<= ${maximumRows}`, actual: rows.length })]
            : []),
          ...sensitiveDifference("execute.rows", outcome.decodedRows ?? [], rows),
        ];
        layers.push(layerResult("execute", started, differences));
      } catch (error) {
        layers.push(freeze({ ...failed("execute", started, error), errorClass: liveErrorClass(error, adapter) }));
      }
    } else layers.push(explicitSkip(outcome, "execute") ?? skipped("execute", "execution-not-meaningful"));

    if (probe.live?.plan === true && adapter.plan !== undefined) {
      const started = performance.now();
      try {
        layers.push(
          layerResult(
            "plan",
            started,
            difference("plan", outcome.plan, await withinTimeout(adapter.plan(request), request.timeoutMilliseconds)),
          ),
        );
      } catch (error) {
        layers.push(freeze({ ...failed("plan", started, error), errorClass: liveErrorClass(error, adapter) }));
      }
    } else layers.push(explicitSkip(outcome, "plan") ?? skipped("plan", "plan-format-unstable"));
  } finally {
    await withinTimeout(adapter.cleanup(probe.id), request.timeoutMilliseconds);
  }
  return createProbeResult(probe, target, outcome, layers);
}

export function createConformanceReport(
  suite: string,
  environment: ConformanceEnvironment,
  results: readonly ConformanceProbeResult[],
  generatedAt = new Date(),
): ConformanceReport {
  const count = (status: ConformanceProbeResult["status"]): number =>
    results.filter((result) => result.status === status).length;
  const exactEligible = results.filter(
    (result) =>
      result.support === "exact" && result.status === "pass" && result.layers.every(({ status }) => status === "pass"),
  ).length;
  return freeze({
    formatVersion: CONFORMANCE_REPORT_FORMAT_VERSION,
    conformanceVersion: CONFORMANCE_VERSION,
    generatedAt: generatedAt.toISOString(),
    suite,
    environment,
    results,
    summary: {
      pass: count("pass"),
      fail: count("fail"),
      skip: count("skip"),
      quarantined: count("quarantined"),
      exactEligible,
    },
  });
}

export function assertExactConformance(report: ConformanceReport): void {
  const invalid = report.results.filter(
    (result) =>
      result.support === "exact" && (result.status !== "pass" || result.layers.some(({ status }) => status !== "pass")),
  );
  if (invalid.length > 0)
    throw new Error(`Exact conformance failed: ${invalid.map(({ probeId }) => probeId).join(", ")}`);
}

export { allLayers as CONFORMANCE_LAYERS };
