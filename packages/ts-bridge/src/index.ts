import { compileSource } from "@typed-sql/compiler";
import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";

export interface OffsetRange {
  readonly start: number;
  readonly end: number;
}

export interface QueryBinding {
  readonly name: string;
  readonly range: OffsetRange;
}

export interface BridgeQuery {
  readonly index: number;
  readonly rowType: string;
  readonly parameterType: string;
  readonly queryType: string;
  readonly sourceRange: OffsetRange;
  readonly transformedRange: OffsetRange;
  readonly interpolationRanges: readonly OffsetRange[];
  readonly binding?: QueryBinding;
}

export interface BridgeInsertion {
  readonly position: number;
  readonly length: number;
}

export interface BridgeAnalysis {
  readonly source: string;
  readonly transformedSource: string;
  readonly insertions: readonly BridgeInsertion[];
  readonly queries: readonly BridgeQuery[];
  readonly diagnostics: ReturnType<typeof compileSource>["diagnostics"];
}

export interface NativeTypeInspection {
  readonly queryIndex: number;
  readonly typeText: string;
}

export interface TypeScriptInspectionInput {
  readonly fileName: string;
  readonly projectFile?: string;
  readonly analysis: BridgeAnalysis;
}

export interface TypeScriptBridge {
  inspectFile(input: TypeScriptInspectionInput): Promise<readonly NativeTypeInspection[]>;
  inspectFiles(
    inputs: readonly TypeScriptInspectionInput[],
  ): Promise<ReadonlyMap<string, readonly NativeTypeInspection[]>>;
  close(): Promise<void>;
}

export interface BridgeAnalyzeOptions {
  readonly maxStructuralVariants?: number;
}

function bindingBefore(source: string, tagStart: number): QueryBinding | undefined {
  const prefix = source.slice(0, tagStart);
  const match = /(?:^|[;{}]\s*|\n\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/u.exec(prefix);
  if (match === null) return undefined;
  const name = match[1];
  if (name === undefined) return undefined;
  const relativeStart = match[0].lastIndexOf(name);
  const start = match.index + relativeStart;
  return { name, range: { start, end: start + name.length } };
}

export function analyzeSource<Snapshot extends SchemaSnapshot, Policy>(
  source: string,
  schema: Snapshot,
  dialect: DialectPlugin<Snapshot, Policy>,
  typePolicy?: Policy,
  options: BridgeAnalyzeOptions = {},
): BridgeAnalysis {
  const compilation = compileSource({
    source,
    schema,
    ...(options.maxStructuralVariants === undefined ? {} : { maxStructuralVariants: options.maxStructuralVariants }),
    dialect,
    ...(typePolicy === undefined ? {} : { typePolicy }),
  });
  const insertions = [
    ...compilation.queries.map(({ query, rowType, parameterType, structural }) => ({
      position: query.insertionPosition,
      length: structural ? rowType.length + parameterType.length + 14 : rowType.length + parameterType.length + 4,
    })),
    ...compilation.fragments.map(({ fragment, parameterType }) => ({
      position: fragment.insertionPosition,
      length: parameterType.length + 2,
    })),
  ].sort((left, right) => left.position - right.position);
  const shiftBefore = (position: number): number =>
    insertions.reduce((total, insertion) => total + (insertion.position < position ? insertion.length : 0), 0);

  const queries = compilation.queries.map(
    ({ query, rowType, parameterType }, index): BridgeQuery => ({
      index,
      rowType,
      parameterType,
      queryType: `Query<${rowType}, ${parameterType}>`,
      sourceRange: { start: query.range.start, end: query.range.end },
      transformedRange: {
        start: query.range.start + shiftBefore(query.range.start),
        end: query.range.end + shiftBefore(query.range.end),
      },
      interpolationRanges: query.interpolations.map(({ sourceStart, sourceEnd }) => ({
        start: sourceStart,
        end: sourceEnd,
      })),
      ...(() => {
        const binding = bindingBefore(source, query.range.start);
        return binding === undefined ? {} : { binding };
      })(),
    }),
  );

  return {
    source,
    transformedSource: compilation.transformedSource,
    insertions,
    queries,
    diagnostics: compilation.diagnostics,
  };
}

export function queryAtPosition(analysis: BridgeAnalysis, position: number): BridgeQuery | undefined {
  return analysis.queries.find(
    (query) =>
      (position >= query.sourceRange.start && position <= query.sourceRange.end) ||
      (query.binding !== undefined && position >= query.binding.range.start && position <= query.binding.range.end),
  );
}

export function isStaticQueryPosition(query: BridgeQuery, position: number): boolean {
  return (
    position >= query.sourceRange.start &&
    position <= query.sourceRange.end &&
    query.interpolationRanges.every(({ start, end }) => position < start || position >= end)
  );
}
