import type { SqlDiagnostic } from "@typed-sql/core";
import { expandRepeatedFragments } from "./repeated-fragments.js";
import {
  type ExtractedQuery,
  findUntaggedStructuralTemplates,
  parseStructuralInterpolation,
  unresolvedStructuralInterpolations,
} from "./scanner.js";
import { expandStructuralQuery } from "./structural.js";

function repeatedUnstableCondition(source: string, query: ExtractedQuery): SqlDiagnostic | undefined {
  const seen = new Set<string>();
  for (const interpolation of query.interpolations) {
    const condition = parseStructuralInterpolation(source, interpolation, query.tagName)?.condition;
    if (!condition) continue;
    if (seen.has(condition) && !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(condition))
      return {
        code: "TSQ016",
        severity: "error",
        range: query.range,
        message:
          "Native acquisition requires stable identifiers for repeated conditions; capture their values before constructing SQL.",
      };
    seen.add(condition);
  }
  return undefined;
}

/** Shared source-level rendering. It never invokes a SQL semantic analyzer. */
export function prepareStaticQuery(
  source: string,
  query: ExtractedQuery,
  placeholder: (index: number) => string,
  maximumVariants: number,
  requireStableConditions = false,
) {
  const diagnostics: SqlDiagnostic[] = [];
  const untaggedStructuralTemplates = findUntaggedStructuralTemplates(source, query);
  if (untaggedStructuralTemplates.length > 0) {
    diagnostics.push(
      ...untaggedStructuralTemplates.map(
        (template): SqlDiagnostic => ({
          code: "TSQ004",
          message: "Untagged template literals are parameter values; SQL structure requires a trusted fragment",
          range: template.range,
          severity: "error",
          suggestion: `Prefix this template with ${template.tagName}.fragment.`,
          fix: {
            title: `Mark as ${template.tagName}.fragment`,
            range: { ...template.range, end: template.range.start },
            newText: `${template.tagName}.fragment`,
            preferred: true,
          },
        }),
      ),
    );
    return { kind: "invalid" as const, diagnostics };
  }
  const repeated = expandRepeatedFragments(source, query, placeholder);
  if (repeated !== undefined && repeated.diagnostics.length > 0) {
    diagnostics.push(...repeated.diagnostics);
    return { kind: "invalid" as const, diagnostics };
  }
  const analyzedQuery = repeated?.query ?? query;
  const unstable = requireStableConditions ? repeatedUnstableCondition(source, analyzedQuery) : undefined;
  if (unstable) return { kind: "invalid" as const, diagnostics: [unstable] };
  const expansion = expandStructuralQuery(source, analyzedQuery, placeholder, maximumVariants);
  if (repeated !== undefined && expansion?.kind === "variants") {
    diagnostics.push({
      code: "TSQ013",
      message: "Fragment lists combined with conditional structural interpolations are not analyzable yet.",
      range: repeated.sites[0]?.sourceSpan ?? query.range,
      severity: "error",
      suggestion: "Move the conditional structure inside one stable fragment skeleton or compose it explicitly.",
    });
    return { kind: "invalid" as const, diagnostics };
  }
  if (expansion?.kind === "limit") {
    diagnostics.push({
      code: "TSQ003",
      message: `Conditional SQL would produce more than ${maximumVariants} structural variants from ${expansion.conditionCount} independent conditions`,
      range: query.range,
      severity: "error",
      suggestion: "Reduce independent template conditions or compose predicates with sql.and()/sql.or().",
    });
    return { kind: "invalid" as const, diagnostics };
  }
  const rendered =
    expansion?.kind === "variants" ? expansion.variants.map((variant) => variant.query) : [analyzedQuery];
  for (const variant of rendered)
    for (const range of unresolvedStructuralInterpolations(source, variant))
      diagnostics.push({
        code: "TSQ016",
        message: "Structural interpolation does not have a complete static rendering.",
        range,
        severity: "error",
      });
  if (diagnostics.length) return { kind: "invalid" as const, diagnostics };
  return { kind: "ready" as const, query: analyzedQuery, repeated, expansion };
}

export function prepareQueryComposition(
  source: string,
  base: ExtractedQuery,
  query: ExtractedQuery,
  placeholder: (index: number) => string,
  maximumVariants: number,
  requireStableConditions = false,
) {
  const unavailable = (message: string) => ({
    kind: "invalid" as const,
    diagnostic: { code: "TSQ016", message, severity: "error" as const, range: query.range },
  });
  if (
    query.interpolations
      .slice(base.interpolations.length)
      .some((item) => parseStructuralInterpolation(source, item, query.tagName) === undefined)
  )
    return unavailable("Runtime metadata requires bounded literal fragments for query composition.");
  const unstable = requireStableConditions ? repeatedUnstableCondition(source, query) : undefined;
  if (unstable) return unavailable(unstable.message);
  const expansion = expandStructuralQuery(source, query, placeholder, maximumVariants);
  if (expansion?.kind !== "variants") return unavailable("Query composition exceeds the supported structural bound.");
  if (expansion.variants.some((variant) => unresolvedStructuralInterpolations(source, variant.query).length))
    return unavailable("Structural query composition does not have a complete static rendering.");
  return { kind: "ready" as const, expansion };
}
