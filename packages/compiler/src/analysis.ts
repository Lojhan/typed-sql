import { createHash } from "node:crypto";
import { type DialectPlugin, resolveDialectCapabilityStates, type SchemaSnapshot } from "@typed-sql/core";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import {
  type CompileSourceOptions,
  compileSource,
  DEFAULT_MAX_GENERATED_DECLARATION_BYTES,
  DEFAULT_MAX_QUERIES,
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MAX_STRUCTURAL_VARIANTS,
} from "./compiler.js";

export const SOURCE_ANALYSIS_FORMAT_VERSION = 1 as const;

export interface SourceAnalysisRange {
  readonly start: number;
  readonly end: number;
}

export interface SourceAnalysisBinding {
  readonly name: string;
  readonly range: SourceAnalysisRange;
}

export interface SourceAnalysisQuery {
  readonly index: number;
  readonly rowType: string;
  readonly parameterType: string;
  readonly queryType: string;
  readonly sourceRange: SourceAnalysisRange;
  readonly transformedRange: SourceAnalysisRange;
  readonly interpolationRanges: readonly SourceAnalysisRange[];
  readonly binding?: SourceAnalysisBinding;
}

export interface SourceAnalysisInsertion {
  readonly position: number;
  readonly length: number;
}

export interface SourceAnalysisProjectIdentity {
  readonly id: string;
  readonly generation: number;
  readonly configHash: string;
}

export interface SourceAnalysisRequest {
  readonly formatVersion: typeof SOURCE_ANALYSIS_FORMAT_VERSION;
  readonly source: {
    readonly id: string;
    readonly text: string;
    readonly version?: number | string;
  };
  readonly project?: SourceAnalysisProjectIdentity;
  readonly compiler?: {
    readonly maxStructuralVariants?: number;
    readonly maxSourceBytes?: number;
    readonly maxQueries?: number;
    readonly maxGeneratedDeclarationBytes?: number;
  };
}

export interface SourceAnalysisContext<Snapshot extends SchemaSnapshot, Policy> {
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
}

export interface SourceAnalysisControl {
  readonly isCancellationRequested: boolean;
}

export interface SourceAnalysisIdentity {
  readonly source: {
    readonly id: string;
    readonly hash: string;
    readonly version?: number | string;
  };
  readonly project?: SourceAnalysisProjectIdentity;
  readonly grammar: {
    readonly id: string;
    readonly version: string;
    readonly capabilityFingerprint: string;
  };
  readonly schema: {
    readonly formatVersion: 1 | 2;
    readonly hash: string;
  };
  readonly typePolicyHash: string;
  readonly compiler: {
    readonly maxStructuralVariants: number;
    readonly maxSourceBytes: number;
    readonly maxQueries: number;
    readonly maxGeneratedDeclarationBytes: number;
  };
}

export interface SourceAnalysisResult {
  readonly formatVersion: typeof SOURCE_ANALYSIS_FORMAT_VERSION;
  readonly revision: string;
  readonly identity: SourceAnalysisIdentity;
  readonly source: string;
  readonly transformedSource: string;
  readonly insertions: readonly SourceAnalysisInsertion[];
  readonly queries: readonly SourceAnalysisQuery[];
  readonly diagnostics: ReturnType<typeof compileSource>["diagnostics"];
}

export interface SourceAnalysisService {
  analyze(request: SourceAnalysisRequest, control?: SourceAnalysisControl): SourceAnalysisResult;
}

const sha256 = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function cancelled(control?: SourceAnalysisControl): void {
  if (control?.isCancellationRequested !== true) return;
  const error = new Error("typed-sql source analysis cancelled");
  error.name = "AbortError";
  throw error;
}

function bindingBefore(source: string, tagStart: number): SourceAnalysisBinding | undefined {
  const prefix = source.slice(0, tagStart);
  const match = /(?:^|[;{}]\s*|\n\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/u.exec(prefix);
  if (match === null) return undefined;
  const name = match[1];
  if (name === undefined) return undefined;
  const relativeStart = match[0].lastIndexOf(name);
  const start = match.index + relativeStart;
  return { name, range: { start, end: start + name.length } };
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return result;
}

function validateRequest(request: SourceAnalysisRequest): void {
  if (request.formatVersion !== SOURCE_ANALYSIS_FORMAT_VERSION) {
    throw new TypeError(`Unsupported source analysis request format ${String(request.formatVersion)}`);
  }
  if (request.source.id.length === 0 || request.source.id.includes("\0")) {
    throw new TypeError("Source analysis id must be a non-empty string without null bytes");
  }
  const version = request.source.version;
  if (
    version !== undefined &&
    !(
      (typeof version === "number" && Number.isSafeInteger(version) && version >= 0) ||
      (typeof version === "string" && version.length > 0 && !version.includes("\0"))
    )
  ) {
    throw new TypeError("Source analysis version must be a non-negative integer or non-empty string");
  }
  const project = request.project;
  if (
    project !== undefined &&
    (project.id.length === 0 ||
      project.id.includes("\0") ||
      !Number.isSafeInteger(project.generation) ||
      project.generation < 0 ||
      project.configHash.length === 0 ||
      project.configHash.includes("\0"))
  ) {
    throw new TypeError("Source analysis project identity is invalid");
  }
}

function resolvedCompilerOptions(request: SourceAnalysisRequest): SourceAnalysisIdentity["compiler"] {
  return Object.freeze({
    maxStructuralVariants: positiveLimit(
      request.compiler?.maxStructuralVariants,
      DEFAULT_MAX_STRUCTURAL_VARIANTS,
      "maxStructuralVariants",
    ),
    maxSourceBytes: positiveLimit(request.compiler?.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, "maxSourceBytes"),
    maxQueries: positiveLimit(request.compiler?.maxQueries, DEFAULT_MAX_QUERIES, "maxQueries"),
    maxGeneratedDeclarationBytes: positiveLimit(
      request.compiler?.maxGeneratedDeclarationBytes,
      DEFAULT_MAX_GENERATED_DECLARATION_BYTES,
      "maxGeneratedDeclarationBytes",
    ),
  });
}

export function analyzeSource<Snapshot extends SchemaSnapshot, Policy>(
  request: SourceAnalysisRequest,
  context: SourceAnalysisContext<Snapshot, Policy>,
  control?: SourceAnalysisControl,
): SourceAnalysisResult {
  validateRequest(request);
  cancelled(control);
  const compiler = resolvedCompilerOptions(request);
  const effectiveTypePolicy = context.typePolicy ?? context.dialect.defaultTypePolicy;
  const capabilityStates = resolveDialectCapabilityStates(context.dialect, context.schema, effectiveTypePolicy);
  const identity: SourceAnalysisIdentity = Object.freeze({
    source: Object.freeze({
      id: request.source.id,
      hash: sha256(request.source.text),
      ...(request.source.version === undefined ? {} : { version: request.source.version }),
    }),
    ...(request.project === undefined ? {} : { project: Object.freeze({ ...request.project }) }),
    grammar: Object.freeze({
      id: context.dialect.id,
      version: context.dialect.grammarVersion,
      capabilityFingerprint: sha256(JSON.stringify(capabilityStates)),
    }),
    schema: Object.freeze({
      formatVersion: context.schema.formatVersion,
      hash: calculateSchemaHash(context.schema),
    }),
    typePolicyHash: calculateTypePolicyHash(effectiveTypePolicy),
    compiler,
  });
  const revision = sha256(JSON.stringify(identity));
  const compilationOptions: CompileSourceOptions<Snapshot, Policy> = {
    source: request.source.text,
    dialect: context.dialect,
    schema: context.schema,
    typePolicy: effectiveTypePolicy,
    ...compiler,
  };
  const compilation = compileSource(compilationOptions);
  cancelled(control);
  const insertions = Object.freeze(
    [
      ...compilation.queries.map(({ query, rowType, parameterType, structural, repeatedFragments }) => ({
        position: query.insertionPosition,
        length:
          repeatedFragments !== undefined
            ? `.__typedRow<${rowType}>()`.length
            : structural
              ? rowType.length + parameterType.length + 14
              : rowType.length + parameterType.length + 4,
      })),
      ...compilation.fragments.map(({ fragment, parameterType }) => ({
        position: fragment.insertionPosition,
        length: parameterType.length + 2,
      })),
    ].sort((left, right) => left.position - right.position),
  );
  const shiftBefore = (position: number): number =>
    insertions.reduce((total, insertion) => total + (insertion.position < position ? insertion.length : 0), 0);
  const queries = Object.freeze(
    compilation.queries.map(
      ({ query, rowType, parameterType }, index): SourceAnalysisQuery => ({
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
          const binding = bindingBefore(request.source.text, query.range.start);
          return binding === undefined ? {} : { binding };
        })(),
      }),
    ),
  );
  return Object.freeze({
    formatVersion: SOURCE_ANALYSIS_FORMAT_VERSION,
    revision,
    identity,
    source: request.source.text,
    transformedSource: compilation.transformedSource,
    insertions,
    queries,
    diagnostics: compilation.diagnostics,
  });
}

export function createSourceAnalysisService<Snapshot extends SchemaSnapshot, Policy>(
  context: SourceAnalysisContext<Snapshot, Policy>,
): SourceAnalysisService {
  return Object.freeze({
    analyze: (request: SourceAnalysisRequest, control?: SourceAnalysisControl) =>
      analyzeSource(request, context, control),
  });
}
