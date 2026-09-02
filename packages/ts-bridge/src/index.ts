import {
  analyzeSource as analyzeCompilerSource,
  SOURCE_ANALYSIS_FORMAT_VERSION,
  type SourceAnalysisBinding,
  type SourceAnalysisControl,
  type SourceAnalysisInsertion,
  type SourceAnalysisProjectIdentity,
  type SourceAnalysisQuery,
  type SourceAnalysisRange,
  type SourceAnalysisResult,
} from "@typed-sql/compiler";
import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";
import type { TypeScriptBackendIdentity, TypeScriptOverlayInput, TypeScriptTypeInspection } from "./backend.js";

export type {
  TypeScriptBackend,
  TypeScriptBackendIdentity,
  TypeScriptBackendSpawnOptions,
  TypeScriptOverlayInput,
  TypeScriptProjectHandle,
  TypeScriptProjectRequest,
  TypeScriptTypeInspection,
} from "./backend.js";
export { createTypeScriptBackend, TYPESCRIPT_BACKEND_ADAPTERS } from "./backends/index.js";
export type { TypeScriptIntegrationSurface, TypeScriptVersionSupport } from "./support.js";
export { TYPESCRIPT_PREVIEW_VERSION, TYPESCRIPT_SUPPORT_POLICY, typeScriptVersionSupport } from "./support.js";

export interface OffsetRange extends SourceAnalysisRange {}

export interface QueryBinding extends SourceAnalysisBinding {}

export interface BridgeQuery extends SourceAnalysisQuery {}

export interface BridgeInsertion extends SourceAnalysisInsertion {}

export interface BridgeAnalysis extends SourceAnalysisResult {}

export interface NativeTypeInspection extends TypeScriptTypeInspection {}

export interface TypeScriptInspectionInput extends TypeScriptOverlayInput {
  readonly analysis: BridgeAnalysis;
}

export interface TypeScriptBridge {
  readonly identity: TypeScriptBackendIdentity;
  inspectFile(input: TypeScriptInspectionInput): Promise<readonly NativeTypeInspection[]>;
  inspectFiles(
    inputs: readonly TypeScriptInspectionInput[],
  ): Promise<ReadonlyMap<string, readonly NativeTypeInspection[]>>;
  close(): Promise<void>;
}

export interface BridgeAnalyzeOptions {
  readonly maxStructuralVariants?: number;
  readonly maxSourceBytes?: number;
  readonly maxQueries?: number;
  readonly maxGeneratedDeclarationBytes?: number;
  readonly sourceId?: string;
  readonly sourceVersion?: number | string;
  readonly project?: SourceAnalysisProjectIdentity;
  readonly cancellation?: SourceAnalysisControl;
}

export function analyzeSource<Snapshot extends SchemaSnapshot, Policy>(
  source: string,
  schema: Snapshot,
  dialect: DialectPlugin<Snapshot, Policy>,
  typePolicy?: Policy,
  options: BridgeAnalyzeOptions = {},
): BridgeAnalysis {
  return analyzeCompilerSource(
    {
      formatVersion: SOURCE_ANALYSIS_FORMAT_VERSION,
      source: {
        id: options.sourceId ?? "inline",
        text: source,
        ...(options.sourceVersion === undefined ? {} : { version: options.sourceVersion }),
      },
      ...(options.project === undefined ? {} : { project: options.project }),
      compiler: {
        ...(options.maxStructuralVariants === undefined
          ? {}
          : { maxStructuralVariants: options.maxStructuralVariants }),
        ...(options.maxSourceBytes === undefined ? {} : { maxSourceBytes: options.maxSourceBytes }),
        ...(options.maxQueries === undefined ? {} : { maxQueries: options.maxQueries }),
        ...(options.maxGeneratedDeclarationBytes === undefined
          ? {}
          : { maxGeneratedDeclarationBytes: options.maxGeneratedDeclarationBytes }),
      },
    },
    { schema, dialect, ...(typePolicy === undefined ? {} : { typePolicy }) },
    options.cancellation,
  );
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
