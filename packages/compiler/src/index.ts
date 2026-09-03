export type {
  SourceAnalysisBinding,
  SourceAnalysisContext,
  SourceAnalysisControl,
  SourceAnalysisIdentity,
  SourceAnalysisInsertion,
  SourceAnalysisProjectIdentity,
  SourceAnalysisQuery,
  SourceAnalysisRange,
  SourceAnalysisRequest,
  SourceAnalysisResult,
  SourceAnalysisService,
} from "./analysis.js";
export { analyzeSource, createSourceAnalysisService, SOURCE_ANALYSIS_FORMAT_VERSION } from "./analysis.js";
export type { CheckFileOptions, CheckFileResult, TypeScriptCheckResult } from "./check.js";
export { checkFile } from "./check.js";
export type {
  AnalyzeSchemaCompatibilityOptions,
  CompatibilityClassification,
  CompatibilityEvidence,
  CompatibilityEvidenceValue,
  CompatibilityQueryReference,
  CompatibilitySeverity,
  DeploymentDirection,
  SchemaCompatibilityAssessment,
  SchemaCompatibilityChange,
  SchemaCompatibilityChangeKind,
  SchemaCompatibilityReport,
  SchemaCompatibilityTarget,
} from "./compatibility.js";
export {
  analyzeSchemaCompatibility,
  parseSchemaCompatibilityReport,
  SCHEMA_COMPATIBILITY_ANALYZER_VERSION,
  SCHEMA_COMPATIBILITY_FORMAT_VERSION,
  serializeSchemaCompatibilityReport,
} from "./compatibility.js";
export type {
  CompiledFragment,
  CompiledQuery,
  CompiledQueryVariant,
  CompileSourceOptions,
  CompileSourceResult,
  FragmentArtifact,
  RepeatedFragmentArtifact,
  StaticFragmentArtifact,
} from "./compiler.js";
export {
  compileSource,
  DEFAULT_MAX_GENERATED_DECLARATION_BYTES,
  DEFAULT_MAX_QUERIES,
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MAX_STRUCTURAL_VARIANTS,
} from "./compiler.js";
export type {
  BuildQueryManifestOptions,
  BuildQueryManifestResult,
  QueryManifest,
  QueryManifestBuildStats,
  QueryManifestCapabilityEvidence,
  QueryManifestColumn,
  QueryManifestDiagnostic,
  QueryManifestEntry,
  QueryManifestLocation,
  QueryManifestParameter,
  QueryManifestRepeatedFragment,
  QueryManifestSemanticEvidence,
  QueryManifestSemanticFact,
  QueryManifestSemantics,
  QueryManifestSource,
  QueryManifestSourceInput,
  QueryManifestVariant,
  ResolvedQueryManifestEntry,
  UnresolvedQueryManifestEntry,
} from "./manifest.js";
export {
  buildQueryManifest,
  parseQueryManifest,
  QUERY_FINGERPRINT_ALGORITHM,
  QUERY_MANIFEST_FORMAT_VERSION,
  QUERY_MANIFEST_JSON_SCHEMA,
  serializeQueryManifest,
} from "./manifest.js";
export type {
  CapturedQueryPlanEntry,
  CaptureQueryPlansOptions,
  CaptureQueryPlansResult,
  FailedQueryPlanEntry,
  QueryPlanArtifact,
  QueryPlanComparisonReason,
  QueryPlanEntry,
  QueryPlanReviewEntry,
  QueryPlanReviewReport,
  QueryPlanViolation,
  QueryPlanViolationKind,
  ReviewQueryPlansOptions,
  SkippedQueryPlanEntry,
} from "./plans.js";
export {
  captureQueryPlans,
  parseQueryPlanArtifact,
  parseQueryPlanReviewReport,
  QUERY_PLAN_CAPTURE_VERSION,
  QUERY_PLAN_FORMAT_VERSION,
  QUERY_PLAN_REVIEW_FORMAT_VERSION,
  reviewQueryPlans,
  serializeQueryPlanArtifact,
  serializeQueryPlanReviewReport,
} from "./plans.js";
export type { ListProjectSourceFilesOptions } from "./project.js";
export { listProjectSourceFiles } from "./project.js";
export type { ExtractedDynamicQuery, ExtractedInterpolation, ExtractedQuery } from "./scanner.js";
export { extractDynamicQueries, extractStaticQueries, mapSqlRange } from "./scanner.js";
export type { TypeScriptCompilerVersionSupport } from "./typescript.js";
export {
  assertTypeScriptCompilerVersion,
  TYPESCRIPT_COMPILER_SUPPORT_POLICY,
  TypeScriptCompilerCompatibilityError,
  typeScriptCompilerVersionSupport,
} from "./typescript.js";
export type {
  CollectQueryVerificationCandidatesOptions,
  FailedQueryProofEntry,
  MismatchedQueryProofEntry,
  QueryVerificationCandidate,
  QueryVerificationEvidence,
  QueryVerificationExpectedField,
  QueryVerificationMismatch,
  QueryVerificationMismatchKind,
  QueryVerificationProof,
  QueryVerificationProofEntry,
  SkippedQueryProofEntry,
  VerifiedQueryProofEntry,
  VerifyQueryManifestOptions,
  VerifyQueryManifestResult,
} from "./verification.js";
export {
  assertQueryVerificationProofCurrent,
  collectQueryVerificationCandidates,
  parseQueryVerificationProof,
  QUERY_VERIFICATION_FORMAT_VERSION,
  QUERY_VERIFIER_VERSION,
  serializeQueryVerificationProof,
  verifyQueryManifest,
} from "./verification.js";
