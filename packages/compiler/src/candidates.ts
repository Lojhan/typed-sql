import { createHash } from "node:crypto";
import {
  assertDialectProfile,
  type DialectProfile,
  type SchemaSnapshot,
  type SourceRange,
  type SqlDiagnostic,
} from "@typed-sql/core";
import {
  DEFAULT_MAX_QUERIES,
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MAX_STRUCTURAL_VARIANTS,
  positiveCompilerLimit,
} from "./limits.js";
import { prepareQueryComposition, prepareStaticQuery } from "./query-preparation.js";
import {
  type ExtractedQuery,
  extractDynamicQueries,
  extractQueryCompositions,
  extractStaticQueries,
} from "./scanner.js";
import { prepareSqlFile } from "./sql-file-preparation.js";

export interface QueryAnalysisCandidate {
  readonly kind: "template" | "composition" | "sql-file";
  readonly sourceRange: SourceRange;
  /** Exact transient rendering; hosts persist a digest, never this source text. */
  readonly sql: string;
  readonly sqlOffsetMap: readonly number[];
  readonly parameterOccurrences: readonly { readonly index: number; readonly start: number; readonly end: number }[];
  /** Physical argument positions to zero-based logical arguments; repeated SQL-file bindings can share one. */
  readonly logicalBindings: readonly number[];
  readonly logicalParameterCount: number;
  /** Hashed condition identities; one candidate covers only this concrete branch assignment. */
  readonly choices: Readonly<Record<string, boolean>>;
}
export interface QueryCandidateCollection {
  readonly candidates: readonly QueryAnalysisCandidate[];
  readonly diagnostics: readonly SqlDiagnostic[];
  readonly complete: boolean;
}
export interface CollectQueryCandidatesOptions<Snapshot extends SchemaSnapshot, Policy> {
  readonly source: string;
  readonly profile: DialectProfile<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
  readonly maxSourceBytes?: number;
  readonly maxQueries?: number;
  readonly maxCandidates?: number;
  readonly maxStructuralVariants?: number;
  readonly maxRenderedSqlBytes?: number;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function collector<Snapshot extends SchemaSnapshot, Policy>(options: CollectQueryCandidatesOptions<Snapshot, Policy>) {
  const { profile, schema, source } = options;
  assertDialectProfile(profile);
  if (schema.dialect !== profile.id)
    throw new TypeError(`Dialect ${profile.id} cannot collect a ${schema.dialect} schema snapshot`);
  const sourceLimit = positiveCompilerLimit(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, "maxSourceBytes"),
    queryLimit = positiveCompilerLimit(options.maxQueries, DEFAULT_MAX_QUERIES, "maxQueries"),
    candidateLimit = positiveCompilerLimit(options.maxCandidates, DEFAULT_MAX_QUERIES, "maxCandidates"),
    renderedLimit = positiveCompilerLimit(options.maxRenderedSqlBytes, 8 * 1024 * 1024, "maxRenderedSqlBytes"),
    variantLimit = positiveCompilerLimit(
      options.maxStructuralVariants,
      DEFAULT_MAX_STRUCTURAL_VARIANTS,
      "maxStructuralVariants",
    );
  const candidates: QueryAnalysisCandidate[] = [],
    diagnostics: SqlDiagnostic[] = [];
  let renderedBytes = 0,
    exhausted = false;
  const report = (code: string, message: string, range: SourceRange) => {
    diagnostics.push({ code, message, range, severity: "error" });
  };
  const resource = (message: string) => {
    exhausted = true;
    report("TSQ006", message, { start: 0, end: source.length, line: 1, column: 1 });
  };
  if (Buffer.byteLength(source) > sourceLimit)
    resource(`Source exceeds the candidate collection limit of ${sourceLimit} bytes.`);
  const add = (input: {
    kind: QueryAnalysisCandidate["kind"];
    sql: string;
    range: SourceRange;
    offsets: readonly number[];
    bindings: readonly number[];
    logicalCount: number;
    choices?: ReadonlyMap<string, boolean>;
    interpolations?: ExtractedQuery["interpolations"];
  }) => {
    if (exhausted) return;
    if (!input.sql.trim()) {
      report("TSQ901", "A query candidate must contain SQL.", input.range);
      return;
    }
    if (profile.parameterOccurrences === undefined) {
      report("TSQ901", "The grammar profile cannot establish native parameter boundaries.", input.range);
      return;
    }
    try {
      const occurrences = profile.parameterOccurrences(
        input.sql,
        schema,
        options.typePolicy ?? profile.defaultTypePolicy,
      );
      let end = 0;
      if (occurrences.length !== input.bindings.length || occurrences.length > 65_535)
        throw new TypeError("Parameter count differs");
      const parameters = occurrences.map((item, offset) => {
        const { start, end: finish } = item.range,
          interpolation = input.interpolations?.[offset];
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(finish) ||
          start < end ||
          finish <= start ||
          finish > input.sql.length ||
          item.index !== offset + 1 ||
          input.sql.slice(start, finish) !== profile.placeholder(item.index) ||
          (input.interpolations !== undefined &&
            (!interpolation ||
              interpolation.index !== item.index ||
              interpolation.sqlStart !== start ||
              interpolation.sqlEnd !== finish))
        )
          throw new TypeError("Parameter layout differs");
        end = finish;
        return Object.freeze({ index: item.index, start, end: finish });
      });
      const bytes = Buffer.byteLength(input.sql);
      if (candidates.length >= candidateLimit || renderedBytes + bytes > renderedLimit) {
        resource("Rendered candidates exceed the configured count or SQL byte limit.");
        return;
      }
      renderedBytes += bytes;
      candidates.push(
        Object.freeze({
          kind: input.kind,
          sourceRange: Object.freeze({ ...input.range }),
          sql: input.sql,
          sqlOffsetMap: Object.freeze([...input.offsets]),
          parameterOccurrences: Object.freeze(parameters),
          logicalBindings: Object.freeze([...input.bindings]),
          logicalParameterCount: input.logicalCount,
          choices: Object.freeze(
            Object.fromEntries(
              [...(input.choices ?? [])]
                .map(([key, value]) => [digest(key), value])
                .sort(([left], [right]) => String(left).localeCompare(String(right))),
            ),
          ),
        }),
      );
    } catch {
      report(
        "TSQ901",
        "The rendered query and grammar-owned parameter layout do not agree; explicit native acquisition is unavailable.",
        input.range,
      );
    }
  };
  const addQuery = (
    kind: "template" | "composition",
    query: ExtractedQuery,
    sourceRange: SourceRange,
    choices?: ReadonlyMap<string, boolean>,
  ) =>
    add({
      kind,
      sql: query.sql,
      range: sourceRange,
      offsets: query.sqlOffsetMap,
      bindings: Array.from({ length: query.parameterCount }, (_, index) => index),
      logicalCount: query.parameterCount,
      interpolations: query.interpolations,
      ...(choices === undefined ? {} : { choices }),
    });
  const finish = (): QueryCandidateCollection =>
    Object.freeze({
      candidates: Object.freeze(exhausted ? [] : candidates),
      diagnostics: Object.freeze(diagnostics.map((item) => Object.freeze(item))),
      complete: !diagnostics.some((item) => item.severity === "error"),
    });
  return {
    add,
    addQuery,
    report,
    resource,
    finish,
    queryLimit,
    candidateLimit,
    variantLimit,
    get exhausted() {
      return exhausted;
    },
  };
}

/** Collects every bounded concrete rendering before invoking any SQL semantic analyzer. */
export function collectSourceQueryCandidates<Snapshot extends SchemaSnapshot, Policy>(
  options: CollectQueryCandidatesOptions<Snapshot, Policy>,
): QueryCandidateCollection {
  const collected = collector(options);
  if (collected.exhausted) return collected.finish();
  const { source, profile } = options,
    placeholder = (index: number) => profile.placeholder(index);
  const modules = [
    ...new Set([profile.sqlModule, ...(profile.runtimeSqlModule === undefined ? [] : [profile.runtimeSqlModule])]),
  ];
  const queries = extractStaticQueries(source, placeholder, modules, collected.queryLimit + 1);
  if (queries.length > collected.queryLimit) {
    collected.resource("Source exceeds the configured static query count.");
    return collected.finish();
  }
  for (const query of queries) {
    const prepared = prepareStaticQuery(source, query, placeholder, collected.variantLimit, true);
    if (prepared.kind === "invalid") {
      for (const item of prepared.diagnostics) collected.report(item.code, item.message, item.range);
      continue;
    }
    if (prepared.repeated?.sites.some((site) => site.dynamic)) {
      collected.report(
        "TSQ013",
        "Native acquisition does not establish invariance for a runtime-sized fragment list.",
        query.range,
      );
      continue;
    }
    if (prepared.expansion?.kind === "variants")
      for (const variant of prepared.expansion.variants)
        collected.addQuery("template", variant.query, query.range, variant.choices);
    else collected.addQuery("template", prepared.query, query.range);
    if (collected.exhausted) break;
  }
  if (!collected.exhausted) {
    const compositions = extractQueryCompositions(source, placeholder, modules, queries, collected.candidateLimit + 1);
    if (compositions.length > collected.candidateLimit)
      collected.resource("Source exceeds the configured query composition count.");
    else
      for (const composition of compositions) {
        if ("unavailable" in composition) {
          collected.report(
            "TSQ016",
            "Query composition has no complete static base and argument rendering.",
            composition.unavailable,
          );
          continue;
        }
        const { base, query } = composition;
        const prepared = prepareQueryComposition(source, base, query, placeholder, collected.variantLimit, true);
        if (prepared.kind === "invalid") {
          const item = prepared.diagnostic;
          collected.report(item.code, item.message, item.range);
          continue;
        }
        for (const variant of prepared.expansion.variants)
          collected.addQuery("composition", variant.query, query.range, variant.choices);
        if (collected.exhausted) break;
      }
  }
  if (!collected.exhausted) {
    const dynamic = extractDynamicQueries(source, modules, collected.queryLimit - queries.length + 1);
    if (dynamic.length + queries.length > collected.queryLimit)
      collected.resource("Source exceeds the configured static/dynamic query count.");
    else
      for (const query of dynamic)
        collected.report("TSQ005", "Dynamic SQL has no complete static rendering for native acquisition.", query.range);
  }
  return collected.finish();
}

/** SQL assets share the exact named/repeated binding normalization used by generated factories. */
export function collectSqlFileQueryCandidates<Snapshot extends SchemaSnapshot, Policy>(
  options: CollectQueryCandidatesOptions<Snapshot, Policy>,
): QueryCandidateCollection {
  const collected = collector(options);
  if (collected.exhausted) return collected.finish();
  const prepared = prepareSqlFile({
    source: options.source,
    schema: options.schema,
    dialect: options.profile,
    ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
    requireRuntimeModule: true,
    ...(options.maxSourceBytes === undefined ? {} : { maxSourceBytes: options.maxSourceBytes }),
  });
  for (const item of prepared.diagnostics) collected.report(item.code, item.message, item.range);
  if (!prepared.diagnostics.some((item) => item.severity === "error"))
    collected.add({
      kind: "sql-file",
      sql: prepared.normalized,
      range: { start: 0, end: options.source.length, line: 1, column: 1 },
      offsets: prepared.offsets,
      bindings: prepared.bindings,
      logicalCount: prepared.count,
    });
  return collected.finish();
}
