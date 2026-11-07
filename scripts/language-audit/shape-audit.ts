import type { DialectServerEvidence } from "../../packages/core/src/index.js";
import { builtinMappers } from "../../tools/grammar-catalog/src/mappers/index.mjs";
import { builtinAuditGrammars } from "./grammars/index.js";
import type { AuditGrammarRegistry } from "./grammars/registry.js";
import { hash } from "./inventory.mjs";
import { planInvocationShapes } from "./invocation-shapes.js";
import type { DiscoveredFunction } from "./invocations.js";
import type { NativePrepare } from "./native-description/contracts.js";

/** Native preparation is the oracle. Rejections require an accepted control before accusing binding. */
export async function auditInvocationShapes(
  grammarId: string,
  version: string,
  rows: readonly DiscoveredFunction[],
  prepare: NativePrepare,
  server?: DialectServerEvidence,
  options: { registry?: AuditGrammarRegistry; mappers?: typeof builtinMappers } = {},
) {
  const owner = (options.registry ?? builtinAuditGrammars).get(grammarId);
  const mapper = (options.mappers ?? builtinMappers).get(grammarId);
  const grammar = owner.createAnalysis(owner.versionBand(version), server);
  const nativeCache = new Map<string, ReturnType<NativePrepare>>();
  const analysisCache = new Map<string, ReturnType<typeof grammar.analyze>>();
  const crashes = new Map<string, string>();
  const observations: Record<string, unknown> = {};
  const entities: {
    name: string;
    sourceRecord: string;
    identity?: string;
    routine?: ReturnType<typeof planInvocationShapes>["routine"];
    cases: string[];
    gaps: string[];
  }[] = [];
  const native = (sql: string) => {
    let result = nativeCache.get(sql);
    if (!result) {
      result = Promise.resolve()
        .then(() => prepare(sql))
        .catch((error) => {
          throw new Error(`Native shape preparation failed for ${sql}: ${String(error)}`, { cause: error });
        });
      nativeCache.set(sql, result);
    }
    return result;
  };
  let failures = 0;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const entity: (typeof entities)[number] = {
      name: row.name,
      sourceRecord: hash(row),
      cases: [] as string[],
      gaps: [] as string[],
    };
    entities.push(entity);
    if (!owner.invocationShapeSyntax) {
      entity.gaps.push("registered-owner-has-no-shape-syntax");
      continue;
    }
    let plan: ReturnType<typeof planInvocationShapes>;
    try {
      plan = planInvocationShapes(row, mapper, owner.invocationShapeSyntax);
    } catch (error) {
      entity.gaps.push(`invalid-plan-evidence:${String(error)}`);
      counts["invalid-plan-evidence"] = (counts["invalid-plan-evidence"] ?? 0) + 1;
      failures++;
      continue;
    }
    entity.identity = plan.identity;
    entity.routine = plan.routine;
    entity.gaps = plan.gaps;
    for (const probe of plan.cases) {
      const control = probe.control ? plan.cases.find((candidate) => candidate.id === probe.control) : undefined;
      if (probe.control && !control) throw new Error("Shape probe references a missing control");
      // Unexpected connection/driver errors propagate; they are not an unavailable SQL case.
      const controlNative = control ? await native(control.sql) : undefined;
      const result = await native(probe.sql);
      if (probe.role === "control" && !result.accepted) entity.gaps.push(`native-control-rejected:${probe.kind}`);
      const key = hash({ probe, controlAccepted: controlNative?.accepted ?? null });
      entity.cases.push(key);
      if (observations[key]) continue;
      let analysis = analysisCache.get(probe.sql);
      if (!analysis && !crashes.has(probe.sql)) {
        try {
          const value = grammar.analyze(probe.sql);
          if (value.columns.some((column) => column.tsType === "any")) throw new Error("Grammar inferred any");
          for (const range of [
            ...value.columns.map((column) => column.range),
            ...value.diagnostics.map((diagnostic) => diagnostic.range),
          ])
            if (
              !Number.isSafeInteger(range.start) ||
              !Number.isSafeInteger(range.end) ||
              range.start < 0 ||
              range.end < range.start ||
              range.end > probe.sql.length
            )
              throw new Error("Grammar returned an invalid source span");
          analysis = { columns: value.columns, parameters: value.parameters, diagnostics: value.diagnostics };
          analysisCache.set(probe.sql, analysis);
        } catch (error) {
          crashes.set(probe.sql, String(error));
        }
      }
      if (!analysis) {
        const status = "grammar-analysis-failure";
        counts[status] = (counts[status] ?? 0) + 1;
        failures++;
        observations[key] = {
          probe,
          status,
          native: result,
          ...(controlNative ? { controlNative } : {}),
          reason: crashes.get(probe.sql),
        };
        continue;
      }
      const typed =
        analysis.diagnostics.length === 0 &&
        analysis.columns.length > 0 &&
        analysis.columns.every((column) => column.tsType !== "unknown");
      const rejection: "binding" | "value" | "unclassified" | undefined = result.accepted
        ? undefined
        : owner.invocationShapeSyntax.rejection([result.reason, result.detail].filter(Boolean).join(": "));
      const unsound: boolean = !result.accepted && controlNative?.accepted === true && typed && rejection === "binding";
      const status = result.accepted
        ? typed
          ? "native-valid-host-typed-binding-only"
          : "native-valid-host-unqualified"
        : unsound
          ? "native-rejected-host-typed"
          : controlNative?.accepted && typed
            ? `native-rejected-${rejection}-host-typed-unverified`
            : controlNative?.accepted
              ? "native-rejected-host-unqualified"
              : "native-control-unverified";
      counts[status] = (counts[status] ?? 0) + 1;
      if (unsound) failures++;
      observations[key] = { probe, status, native: result, ...(controlNative ? { controlNative } : {}), analysis };
    }
  }
  const incomplete =
    entities.some((entity) => entity.gaps.length > 0) ||
    Object.entries(counts).some(
      ([status, count]) => count > 0 && (status.includes("unqualified") || status.includes("unverified")),
    );
  return {
    formatVersion: 1,
    qualification: failures ? "failed" : incomplete ? "incomplete" : "binding-cases-only",
    grammar: grammarId,
    version,
    scope:
      "generated invocation binding shapes; type, nullability, values and decoding remain independently unqualified",
    inventoryDigest: hash(rows),
    sourceRecords: Object.fromEntries(rows.map((row) => [hash(row), row])),
    entities,
    observations,
    counts,
    failures,
    uniqueStatements: nativeCache.size,
  };
}
