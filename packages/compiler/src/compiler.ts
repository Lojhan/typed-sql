import { createHash } from "node:crypto";
import {
  type DialectPlugin,
  mapQuerySemanticRanges,
  mergeQuerySemantics,
  parameterTypeLiteral,
  type QuerySemantics,
  type ResolvedColumn,
  type ResolvedParameter,
  rowTypeLiteral,
  type SchemaSnapshot,
  type SqlDiagnostic,
} from "@typed-sql/core";
import { expandRepeatedFragments, type RepeatedFragmentSite } from "./repeated-fragments.js";
import {
  type ExtractedQuery,
  extractAppendFragments,
  extractStaticQueries,
  findUntaggedStructuralTemplates,
  mapSqlRange,
} from "./scanner.js";
import { expandStructuralQuery, structuralRowType } from "./structural.js";

export const DEFAULT_MAX_STRUCTURAL_VARIANTS = 64;
export const DEFAULT_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_QUERIES = 10_000;
export const DEFAULT_MAX_GENERATED_DECLARATION_BYTES = 8 * 1024 * 1024;

export interface CompiledQuery {
  readonly query: ExtractedQuery;
  readonly rowType: string;
  readonly parameterType: string;
  readonly structural?: true;
  readonly repeatedFragments?: readonly RepeatedFragmentSite[];
  readonly fingerprint: string;
  readonly variantFingerprints: readonly string[];
  readonly variants: readonly CompiledQueryVariant[];
  readonly semantics: QuerySemantics;
}

export interface CompiledQueryVariant {
  readonly fingerprint: string;
  /** Exact transient SQL used for native verification; never serialized into query manifests. */
  readonly sql: string;
  readonly rowType: string;
  readonly parameterType: string;
  readonly choices: Readonly<Record<string, boolean>>;
  readonly columns: readonly ResolvedColumn[];
  readonly parameters: readonly ResolvedParameter[];
  readonly semantics: QuerySemantics;
}

export interface CompiledFragment {
  readonly fragment: ExtractedQuery;
  readonly parameterType: string;
}

export interface CompileSourceResult {
  readonly transformedSource: string;
  readonly queries: readonly CompiledQuery[];
  readonly fragments: readonly CompiledFragment[];
  readonly diagnostics: readonly SqlDiagnostic[];
}

export interface CompileSourceOptions<Snapshot extends SchemaSnapshot, Policy> {
  readonly source: string;
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
  readonly maxStructuralVariants?: number;
  readonly maxSourceBytes?: number;
  readonly maxQueries?: number;
  readonly maxGeneratedDeclarationBytes?: number;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return limit;
}

function resourceLimit(source: string, message: string): CompileSourceResult {
  return {
    transformedSource: source,
    queries: [],
    fragments: [],
    diagnostics: [
      {
        code: "TSQ006",
        message,
        range: { start: 0, end: source.length, line: 1, column: 1 },
        severity: "error",
        suggestion: "Reduce the source unit or raise the corresponding compiler limit explicitly.",
      },
    ],
  };
}

function mapDiagnostic(source: string, query: ExtractedQuery, diagnostic: SqlDiagnostic): SqlDiagnostic {
  return { ...diagnostic, range: mapSqlRange(source, query, diagnostic.range) };
}

function fingerprint(dialect: Pick<DialectPlugin, "id" | "grammarVersion">, sql: string): string {
  return `sha256:${createHash("sha256").update(`${dialect.id}\0${dialect.grammarVersion}\0${sql}`).digest("hex")}`;
}

function sourceSemantics(source: string, query: ExtractedQuery, semantics: QuerySemantics): QuerySemantics {
  return mapQuerySemanticRanges(semantics, (range) => mapSqlRange(source, query, range));
}

function deduplicateDiagnostics(diagnostics: readonly SqlDiagnostic[]): readonly SqlDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.code,
      diagnostic.severity,
      diagnostic.message,
      diagnostic.range.start,
      diagnostic.range.end,
      diagnostic.suggestion ?? "",
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function compileSource<Snapshot extends SchemaSnapshot, Policy>(
  options: CompileSourceOptions<Snapshot, Policy>,
): CompileSourceResult {
  const { source, dialect, schema } = options;
  if (schema.dialect !== dialect.id) {
    throw new TypeError(`Dialect ${dialect.id} cannot compile a ${schema.dialect} schema snapshot`);
  }
  const maximumVariants = positiveLimit(
    options.maxStructuralVariants,
    DEFAULT_MAX_STRUCTURAL_VARIANTS,
    "maxStructuralVariants",
  );
  const maximumSourceBytes = positiveLimit(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, "maxSourceBytes");
  const maximumQueries = positiveLimit(options.maxQueries, DEFAULT_MAX_QUERIES, "maxQueries");
  const maximumGeneratedDeclarationBytes = positiveLimit(
    options.maxGeneratedDeclarationBytes,
    DEFAULT_MAX_GENERATED_DECLARATION_BYTES,
    "maxGeneratedDeclarationBytes",
  );
  const sourceBytes = Buffer.byteLength(source);
  if (sourceBytes > maximumSourceBytes) {
    return resourceLimit(source, `Source uses ${sourceBytes} bytes; the configured limit is ${maximumSourceBytes}.`);
  }
  const extracted = extractStaticQueries(source, (index) => dialect.placeholder(index), [dialect.sqlModule]);
  if (extracted.length > maximumQueries) {
    return resourceLimit(
      source,
      `Source contains ${extracted.length} static queries; the configured limit is ${maximumQueries}.`,
    );
  }
  const compiled: CompiledQuery[] = [];
  const compiledFragments: CompiledFragment[] = [];
  const diagnostics: SqlDiagnostic[] = [];
  const analyses = new Map<string, ReturnType<typeof dialect.analyze>>();
  const fingerprints = new Map<string, string>();
  const analyze = (sql: string): ReturnType<typeof dialect.analyze> => {
    const cached = analyses.get(sql);
    if (cached !== undefined) return cached;
    const resolved = dialect.analyze(sql, schema, options.typePolicy);
    analyses.set(sql, resolved);
    return resolved;
  };
  const identify = (sql: string): string => {
    const cached = fingerprints.get(sql);
    if (cached !== undefined) return cached;
    const result = fingerprint(dialect, sql);
    fingerprints.set(sql, result);
    return result;
  };
  for (const query of extracted) {
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
      continue;
    }
    const repeated = expandRepeatedFragments(source, query, (index) => dialect.placeholder(index));
    if (repeated !== undefined && repeated.diagnostics.length > 0) {
      diagnostics.push(...repeated.diagnostics);
      continue;
    }
    const analyzedQuery = repeated?.query ?? query;
    const expansion = expandStructuralQuery(
      source,
      analyzedQuery,
      (index) => dialect.placeholder(index),
      maximumVariants,
    );
    if (repeated !== undefined && expansion?.kind === "variants") {
      diagnostics.push({
        code: "TSQ013",
        message: "Fragment lists combined with conditional structural interpolations are not analyzable yet.",
        range: repeated.sites[0]?.sourceSpan ?? query.range,
        severity: "error",
        suggestion: "Move the conditional structure inside one stable fragment skeleton or compose it explicitly.",
      });
      continue;
    }
    if (expansion?.kind === "limit") {
      diagnostics.push({
        code: "TSQ003",
        message: `Conditional SQL would produce more than ${maximumVariants} structural variants from ${expansion.conditionCount} independent conditions`,
        range: query.range,
        severity: "error",
        suggestion: "Reduce independent template conditions or compose predicates with sql.and()/sql.or().",
      });
      continue;
    }
    if (expansion?.kind === "variants") {
      const resolvedVariants = expansion.variants.map((variant) => ({
        variant,
        resolved: analyze(variant.query.sql),
        fingerprint: identify(variant.query.sql),
      }));
      for (const { variant, resolved } of resolvedVariants) {
        diagnostics.push(...resolved.diagnostics.map((diagnostic) => mapDiagnostic(source, variant.query, diagnostic)));
      }
      if (
        !resolvedVariants.some(({ resolved }) =>
          resolved.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
        )
      ) {
        const variants: readonly CompiledQueryVariant[] = resolvedVariants.map(
          ({ variant, resolved, fingerprint }) => ({
            fingerprint,
            sql: variant.query.sql,
            rowType: resolved.resultKind === "command" ? "never" : rowTypeLiteral(resolved.columns),
            parameterType: parameterTypeLiteral(variant.query.parameterCount, resolved.parameters),
            choices: Object.freeze(
              Object.fromEntries(
                [...variant.choices].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
              ),
            ),
            columns: Object.freeze(
              resolved.columns.map((column) => ({
                ...column,
                range: mapSqlRange(source, variant.query, column.range),
              })),
            ),
            parameters: Object.freeze(resolved.parameters.map((parameter) => Object.freeze({ ...parameter }))),
            semantics: sourceSemantics(source, variant.query, resolved.semantics),
          }),
        );
        const rows = resolvedVariants.map(({ variant, resolved }) => ({
          row: resolved.resultKind === "command" ? "never" : rowTypeLiteral(resolved.columns),
          choices: variant.choices,
        }));
        const parameterTypes = [
          ...new Set(
            resolvedVariants.map(({ variant, resolved }) =>
              parameterTypeLiteral(variant.query.parameterCount, resolved.parameters),
            ),
          ),
        ];
        const byPosition = new Map<
          number,
          {
            readonly fragment: ExtractedQuery;
            readonly parameterTypes: Set<string>;
          }
        >();
        for (const { variant, resolved } of resolvedVariants) {
          for (const item of variant.fragments) {
            const parameters = resolved.parameters
              .filter(
                (parameter) =>
                  parameter.index > item.parameterOffset &&
                  parameter.index <= item.parameterOffset + item.query.parameterCount,
              )
              .map((parameter): ResolvedParameter => ({ ...parameter, index: parameter.index - item.parameterOffset }));
            const parameterType = parameterTypeLiteral(item.query.parameterCount, parameters);
            const existing = byPosition.get(item.query.insertionPosition);
            if (existing === undefined) {
              byPosition.set(item.query.insertionPosition, {
                fragment: item.query,
                parameterTypes: new Set([parameterType]),
              });
            } else existing.parameterTypes.add(parameterType);
          }
        }
        const conflicts = [...byPosition.values()].filter((item) => item.parameterTypes.size > 1);
        if (conflicts.length > 0) {
          diagnostics.push(
            ...conflicts.map(
              (item): SqlDiagnostic => ({
                code: "TSQ205",
                message: `Fragment parameters have incompatible structural contexts: ${[...item.parameterTypes].join(" or ")}`,
                range: item.fragment.range,
                severity: "error",
                suggestion: "Move the fragment into the conditional branch that determines its parameter context.",
              }),
            ),
          );
          continue;
        }
        compiled.push({
          query,
          rowType: structuralRowType(source, query, rows),
          parameterType: parameterTypes.join(" | "),
          structural: true,
          ...(repeated === undefined ? {} : { repeatedFragments: repeated.sites }),
          variantFingerprints: Object.freeze(
            [...new Set(resolvedVariants.map((variant) => variant.fingerprint))].sort(),
          ),
          fingerprint: identify([...new Set(resolvedVariants.map((variant) => variant.fingerprint))].sort().join("\0")),
          variants,
          semantics: mergeQuerySemantics(variants.map((variant) => variant.semantics)),
        });
        compiledFragments.push(
          ...[...byPosition.values()].map((item) => ({
            fragment: item.fragment,
            parameterType: [...item.parameterTypes][0]!,
          })),
        );
      }
      continue;
    }
    const resolved = analyze(analyzedQuery.sql);
    diagnostics.push(...resolved.diagnostics.map((diagnostic) => mapDiagnostic(source, analyzedQuery, diagnostic)));
    if (!resolved.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      const queryFingerprint = identify(analyzedQuery.sql);
      const semantics = sourceSemantics(source, analyzedQuery, resolved.semantics);
      const repeatedFragments = new Map<number, CompiledFragment>();
      for (const item of repeated?.fragments ?? []) {
        const parameters = resolved.parameters
          .filter(
            (parameter) =>
              parameter.index > item.parameterOffset &&
              parameter.index <= item.parameterOffset + item.query.parameterCount,
          )
          .map((parameter): ResolvedParameter => ({ ...parameter, index: parameter.index - item.parameterOffset }));
        repeatedFragments.set(item.query.insertionPosition, {
          fragment: item.query,
          parameterType: parameterTypeLiteral(item.query.parameterCount, parameters),
        });
      }
      compiledFragments.push(...repeatedFragments.values());
      compiled.push({
        query,
        rowType: resolved.resultKind === "command" ? "never" : rowTypeLiteral(resolved.columns),
        parameterType:
          repeated?.sites.some(({ dynamic }) => dynamic) === true
            ? "readonly unknown[]"
            : parameterTypeLiteral(analyzedQuery.parameterCount, resolved.parameters),
        ...(repeated === undefined ? {} : { repeatedFragments: repeated.sites }),
        fingerprint: queryFingerprint,
        variantFingerprints: Object.freeze([queryFingerprint]),
        variants: Object.freeze([
          {
            fingerprint: queryFingerprint,
            sql: analyzedQuery.sql,
            rowType: resolved.resultKind === "command" ? "never" : rowTypeLiteral(resolved.columns),
            parameterType: parameterTypeLiteral(analyzedQuery.parameterCount, resolved.parameters),
            choices: Object.freeze({}),
            columns: Object.freeze(
              resolved.columns.map((column) => ({
                ...column,
                range: mapSqlRange(source, query, column.range),
              })),
            ),
            parameters: Object.freeze(resolved.parameters.map((parameter) => Object.freeze({ ...parameter }))),
            semantics,
          },
        ]),
        semantics,
      });
    }
  }
  const appendFragments = extractAppendFragments(
    source,
    (index) => dialect.placeholder(index),
    [dialect.sqlModule],
    extracted,
  );
  for (const { base, prefix, fragment, parameterOffset } of appendFragments) {
    const contextualSql = [base, ...prefix, fragment];
    const combined: ExtractedQuery = {
      ...base,
      sql: contextualSql.map((item) => item.sql).join(""),
      parameterCount: parameterOffset + fragment.parameterCount,
      range: { ...base.range, end: fragment.range.end },
      sqlOffsetMap: contextualSql.flatMap((item) => item.sqlOffsetMap),
    };
    const resolved = analyze(combined.sql);
    const fragmentStart = combined.sql.length - fragment.sql.length;
    const fragmentDiagnostics = resolved.diagnostics.filter((diagnostic) => diagnostic.range.start >= fragmentStart);
    diagnostics.push(...fragmentDiagnostics.map((diagnostic) => mapDiagnostic(source, combined, diagnostic)));
    if (!resolved.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      const parameters = resolved.parameters
        .filter((parameter) => parameter.index > parameterOffset)
        .map((parameter): ResolvedParameter => ({ ...parameter, index: parameter.index - parameterOffset }));
      compiledFragments.push({
        fragment,
        parameterType: parameterTypeLiteral(fragment.parameterCount, parameters),
      });
    }
  }
  let transformedSource = source;
  const insertions = [
    ...compiled.map((item) => ({
      position: item.query.insertionPosition,
      text:
        item.repeatedFragments !== undefined
          ? `.__typedRow<${item.rowType}>()`
          : item.structural
            ? `.__typed<${item.rowType}, ${item.parameterType}>()`
            : `<${item.rowType}, ${item.parameterType}>`,
    })),
    ...compiledFragments.map((item) => ({
      position: item.fragment.insertionPosition,
      text: `<${item.parameterType}>`,
    })),
  ];
  for (const insertion of insertions.sort((left, right) => right.position - left.position)) {
    transformedSource = `${transformedSource.slice(0, insertion.position)}${insertion.text}${transformedSource.slice(insertion.position)}`;
  }
  const generatedDeclarationBytes = Buffer.byteLength(transformedSource) - sourceBytes;
  if (generatedDeclarationBytes > maximumGeneratedDeclarationBytes) {
    return resourceLimit(
      source,
      `Generated declarations use ${generatedDeclarationBytes} bytes; the configured limit is ${maximumGeneratedDeclarationBytes}.`,
    );
  }
  return {
    transformedSource,
    queries: compiled,
    fragments: compiledFragments,
    diagnostics: deduplicateDiagnostics(diagnostics),
  };
}
