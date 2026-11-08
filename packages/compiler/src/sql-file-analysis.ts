import {
  type DialectAnalysis,
  type DialectPlugin,
  mapQuerySemanticRanges,
  type SchemaSnapshot,
  type SourceRange,
} from "@typed-sql/core";
import { type PrepareSqlFileOptions, prepareSqlFile } from "./sql-file-preparation.js";
export interface AnalyzeSqlFileOptions<Snapshot extends SchemaSnapshot, Policy>
  extends Omit<PrepareSqlFileOptions<Snapshot, Policy>, "dialect"> {
  readonly dialect: PrepareSqlFileOptions<Snapshot, Policy>["dialect"] &
    Pick<DialectPlugin<Snapshot, Policy>, "analyze">;
}
/** Binding preparation remains independent of SQL semantic success. */
export function analyzeSqlFile<Snapshot extends SchemaSnapshot, Policy>(
  options: AnalyzeSqlFileOptions<Snapshot, Policy>,
) {
  const { dialect, schema, typePolicy } = options,
    policy = typePolicy ?? dialect.defaultTypePolicy;
  const {
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
  } = prepareSqlFile(options);
  let analysis: DialectAnalysis | undefined;
  if (diagnostics.length === 0) {
    try {
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
