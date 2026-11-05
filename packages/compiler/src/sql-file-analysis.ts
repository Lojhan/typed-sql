import {
  type DialectAnalysis,
  type DialectPlugin,
  mapQuerySemanticRanges,
  type SchemaSnapshot,
  type SourceRange,
  type SqlDiagnostic,
} from "@typed-sql/core";
import { DEFAULT_MAX_SOURCE_BYTES } from "./limits.js";
import { positionRange } from "./scanner.js";

export interface AnalyzeSqlFileOptions<Snapshot extends SchemaSnapshot, Policy> {
  readonly source: string;
  readonly dialect: Pick<
    DialectPlugin<Snapshot, Policy>,
    "defaultTypePolicy" | "placeholder" | "parameterOccurrences" | "analyze" | "runtimeSqlModule"
  >;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
  readonly requireRuntimeModule?: boolean;
}

/** Shared SQL asset binding analysis; no Node APIs, code execution, or database connection. */
export function analyzeSqlFile<Snapshot extends SchemaSnapshot, Policy>(
  options: AnalyzeSqlFileOptions<Snapshot, Policy>,
) {
  const { source: content, dialect, typePolicy, schema } = options;
  const policy = typePolicy ?? dialect.defaultTypePolicy;
  const diagnostics: SqlDiagnostic[] = [];
  const unavailable = (message: string): SqlDiagnostic => ({
    code: "TSQ901",
    severity: "error",
    message,
    range: { start: 0, end: Math.min(content.length, 1), line: 1, column: 1 },
  });
  if (new TextEncoder().encode(content).byteLength > DEFAULT_MAX_SOURCE_BYTES)
    diagnostics.push(unavailable("SQL file exceeds the source size limit."));
  if (options.requireRuntimeModule === true && dialect.runtimeSqlModule === undefined)
    diagnostics.push(unavailable("SQL files require a grammar portable runtime entrypoint."));
  const parts: string[] = [];
  const bindings: number[] = [];
  const lastBindingRange = new Map<number, SourceRange>();
  const names: string[] = [];
  const nameIndexes = new Map<string, number>();
  const offsets: number[] = [];
  let normalized = "";
  let count = 0;
  let named = false;
  let analysis: DialectAnalysis | undefined;
  const mapRange = (range: SourceRange): SourceRange => {
    const start = offsets[range.start] ?? content.length;
    const end = range.end <= range.start ? start : (offsets[range.end - 1] ?? content.length - 1) + 1;
    return positionRange(content, start, end);
  };
  if (diagnostics.length === 0) {
    if (dialect.parameterOccurrences === undefined)
      diagnostics.push(unavailable("This grammar does not support SQL-file parameter binding."));
    else
      try {
        const occurrences = dialect.parameterOccurrences(content, schema, policy);
        named = occurrences.some((occurrence) => occurrence.name !== undefined);
        if (named && occurrences.some((occurrence) => occurrence.name === undefined))
          diagnostics.push(unavailable("SQL files cannot mix named and positional parameters."));
        let end = 0;
        for (const occurrence of occurrences) {
          const { start, end: occurrenceEnd } = occurrence.range;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(occurrenceEnd) ||
            start < end ||
            occurrenceEnd <= start ||
            occurrenceEnd > content.length
          ) {
            diagnostics.push(unavailable("The grammar returned invalid SQL parameter occurrence ranges."));
            break;
          }
          let index = occurrence.index;
          if (named) {
            const name = occurrence.name!;
            if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
              diagnostics.push(unavailable("Invalid named SQL parameter."));
              break;
            }
            const existing = nameIndexes.get(name);
            if (existing === undefined) {
              names.push(name);
              nameIndexes.set(name, names.length);
            }
            index = existing ?? names.length;
          }
          if (!Number.isSafeInteger(index) || index < 1 || index > 65_535) {
            diagnostics.push({ ...unavailable("Invalid SQL parameter index."), range: occurrence.range });
            break;
          }
          parts.push(content.slice(end, start));
          for (let offset = end; offset < start; offset += 1) offsets.push(offset);
          const marker = dialect.placeholder(bindings.length + 1);
          for (let offset = 0; offset < marker.length; offset += 1)
            offsets.push(offset === marker.length - 1 ? occurrenceEnd - 1 : start);
          normalized += parts[parts.length - 1] + marker;
          bindings.push(index - 1);
          lastBindingRange.set(index - 1, occurrence.range);
          count = Math.max(count, index);
          end = occurrenceEnd;
        }
        parts.push(content.slice(end));
        normalized += content.slice(end);
        for (let offset = end; offset < content.length; offset += 1) offsets.push(offset);
        if (new Set(bindings).size !== count)
          diagnostics.push(
            unavailable("SQL parameter indexes must be contiguous from 1; unused gaps are unsupported."),
          );
        if (diagnostics.length === 0) {
          const resolved = dialect.analyze(normalized, schema, policy, { runtimeValidation: true });
          analysis = {
            ...resolved,
            columns: resolved.columns.map((column) => ({ ...column, range: mapRange(column.range) })),
            parameters: resolved.parameters,
            semantics: mapQuerySemanticRanges(resolved.semantics, mapRange),
          };
          diagnostics.push(
            ...resolved.diagnostics.map((diagnostic) => ({
              ...diagnostic,
              range: mapRange(diagnostic.range),
              ...(diagnostic.fix === undefined
                ? {}
                : { fix: { ...diagnostic.fix, range: mapRange(diagnostic.fix.range) } }),
            })),
          );
          const indexes = new Set(analysis.parameters.map((parameter) => parameter.index));
          if (
            indexes.size !== bindings.length ||
            analysis.parameters.length !== bindings.length ||
            [...indexes].some((index) => !Number.isSafeInteger(index) || index < 1 || index > bindings.length)
          )
            diagnostics.push(
              unavailable("The grammar's SQL parameter occurrences do not match its inferred parameter contract."),
            );
        }
      } catch (error) {
        const failure = error as { message?: string; range?: SourceRange };
        diagnostics.push({
          ...unavailable(failure.message ?? "Invalid SQL file parameters."),
          ...(failure.range === undefined ? {} : { range: failure.range }),
        });
      }
  }
  const groupedParameters = new Map<number, NonNullable<typeof analysis>["parameters"][number][]>();
  for (const parameter of analysis?.parameters ?? []) {
    const binding = bindings[parameter.index - 1]!;
    const group = groupedParameters.get(binding);
    if (group === undefined) groupedParameters.set(binding, [parameter]);
    else group.push(parameter);
  }
  const logicalParameters = Array.from({ length: count }, (_, index) => {
    const values = groupedParameters.get(index) ?? [];
    const first = values[0];
    if (first === undefined) return undefined;
    if (
      values.some(
        (parameter) =>
          parameter.tsType !== first.tsType ||
          parameter.databaseType !== first.databaseType ||
          JSON.stringify(parameter.json) !== JSON.stringify(first.json) ||
          JSON.stringify(parameter.runtimeType) !== JSON.stringify(first.runtimeType) ||
          JSON.stringify(parameter.scalarJsonShape) !== JSON.stringify(first.scalarJsonShape) ||
          parameter.acceptsJsonInput !== first.acceptsJsonInput,
      )
    )
      diagnostics.push({
        ...unavailable("Repeated SQL parameter has incompatible inferred types; use consistent explicit casts."),
        range: lastBindingRange.get(index) ?? unavailable("").range,
      });
    return { ...first, index: index + 1, nullable: values.every((value) => value.nullable) };
  }).filter((parameter) => parameter !== undefined);
  return { analysis, diagnostics, parts, bindings, names, count, named, offsets, normalized, logicalParameters };
}
