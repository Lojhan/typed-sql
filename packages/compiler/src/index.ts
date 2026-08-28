export type { CheckFileOptions, CheckFileResult, TypeScriptCheckResult } from "./check.js";
export { checkFile } from "./check.js";
export type {
  CompiledFragment,
  CompiledQuery,
  CompiledQueryVariant,
  CompileSourceOptions,
  CompileSourceResult,
} from "./compiler.js";
export { compileSource } from "./compiler.js";
export type {
  BuildQueryManifestOptions,
  BuildQueryManifestResult,
  QueryManifest,
  QueryManifestBuildStats,
  QueryManifestColumn,
  QueryManifestDiagnostic,
  QueryManifestEntry,
  QueryManifestLocation,
  QueryManifestParameter,
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
export type { ListProjectSourceFilesOptions } from "./project.js";
export { listProjectSourceFiles } from "./project.js";
export type { ExtractedDynamicQuery, ExtractedInterpolation, ExtractedQuery } from "./scanner.js";
export { extractDynamicQueries, extractStaticQueries, mapSqlRange } from "./scanner.js";
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
