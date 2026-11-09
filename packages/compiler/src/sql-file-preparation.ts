import type { DialectProfile, SchemaSnapshot, SourceRange, SqlDiagnostic } from "@typed-sql/core";
import { DEFAULT_MAX_SOURCE_BYTES, positiveCompilerLimit } from "./limits.js";
import { positionRange } from "./scanner.js";
export interface PrepareSqlFileOptions<Snapshot extends SchemaSnapshot, Policy> {
  readonly source: string;
  readonly dialect: Pick<
    DialectProfile<Snapshot, Policy>,
    "defaultTypePolicy" | "placeholder" | "parameterOccurrences" | "runtimeSqlModule"
  >;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
  readonly requireRuntimeModule?: boolean;
  readonly maxSourceBytes?: number;
}
/** Pure binding normalization shared by query acquisition and semantic SQL-file analysis. */
export function prepareSqlFile<Snapshot extends SchemaSnapshot, Policy>(
  options: PrepareSqlFileOptions<Snapshot, Policy>,
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
  if (
    new TextEncoder().encode(content).byteLength >
    positiveCompilerLimit(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, "maxSourceBytes")
  )
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
      } catch (error) {
        const failure = error as { message?: string; range?: SourceRange };
        diagnostics.push({
          ...unavailable(failure.message ?? "Invalid SQL file parameters."),
          ...(failure.range === undefined ? {} : { range: failure.range }),
        });
      }
  }
  return {
    diagnostics,
    parts,
    bindings,
    names,
    count,
    named,
    offsets,
    normalized,
    lastBindingRange,
    mapRange,
    unavailable,
  };
}
