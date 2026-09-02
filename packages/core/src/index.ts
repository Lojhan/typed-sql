export type {
  AdapterCapability,
  AdapterCapabilityHost,
  AdapterCapabilityResolver,
  AdapterCapabilityService,
} from "./adapter-capabilities.js";
export {
  adapterCapabilities,
  createAdapterCapabilityResolver,
  defineAdapterCapability,
  getAdapterCapability,
  hasAdapterCapability,
  requireAdapterCapability,
  UnsupportedAdapterCapabilityError,
} from "./adapter-capabilities.js";
export type {
  ArtifactCompatibilityAssessment,
  ArtifactCompatibilityIdentity,
  ArtifactCompatibilityOutcome,
} from "./artifact-compatibility.js";
export {
  ARTIFACT_COMPATIBILITY_IDENTITY_FORMAT_VERSION,
  assessArtifactCompatibility,
  CORE_ARTIFACT_COMPATIBILITY_VERSION,
  parseArtifactCompatibilityIdentity,
  serializeArtifactCompatibilityIdentity,
} from "./artifact-compatibility.js";
export type {
  DebugEvent,
  DebugEventInput,
  DebugRedactionOptions,
  SupportBundle,
} from "./debug.js";
export {
  createDebugEvent,
  createSupportBundle,
  redactDebugContext,
  SUPPORT_BUNDLE_FORMAT_VERSION,
  serializeSupportBundle,
} from "./debug.js";
export type { TypedSqlDiagnosticCode } from "./diagnostics.js";
export { diagnosticRegistry, isTypedSqlDiagnosticCode } from "./diagnostics.js";
export type {
  BooleanDialectCapabilities,
  DialectCapabilityEvidence,
  DialectCapabilityEvidenceKind,
  DialectCapabilityHost,
  DialectCapabilityIssue,
  DialectCapabilityLevel,
  DialectCapabilityState,
  DialectCapabilityStates,
  DialectServerEvidence,
  DialectServerSetting,
} from "./dialect-capabilities.js";
export {
  applyDialectCapabilityStates,
  defineDialectCapabilityStates,
  defineDialectServerEvidence,
  dialectCapabilityIssues,
  parseDialectServerEvidence,
  resolveDialectCapabilityStates,
  staticDialectCapabilityStates,
} from "./dialect-capabilities.js";
export type {
  ExecutionCapabilities,
  ExecutionCapability,
  ExecutionOptions,
  QueryBatch,
  QueryCancellationReason,
  QueryCardinalityExpectation,
  QueryResult,
  QueryResults,
  QueryStream,
  StreamOptions,
} from "./execution.js";
export {
  assertExecutionCapabilities,
  executionDeadline,
  QueryCancelledError,
  QueryCardinalityError,
  runControlledExecution,
  UnsupportedExecutionCapabilityError,
} from "./execution.js";
export type {
  ActiveDatabaseObservation,
  BatchOperationStart,
  DatabaseObservation,
  DatabaseObservationStatus,
  DatabaseObserver,
  DatabaseOperationCompletion,
  DatabaseOperationEnd,
  DatabaseOperationStart,
  QueryObservationCardinality,
  QueryOperationStart,
  StreamOperationStart,
  TransactionOperationStart,
} from "./observation.js";
export { databaseErrorCompletion, observeQueryStream, startDatabaseObservation } from "./observation.js";
export type {
  ControlledQueryExecutor,
  Database,
  OptionalSqlFragment,
  Query,
  QueryExecutor,
  QueryParameters,
  QueryRenderSkeleton,
  QueryRow,
  RenderedQuery,
  SqlFragment,
  SqlRenderer,
  SqlSegment,
  SqlTag,
  TransactionDatabase,
  TransactionRunner,
} from "./query.js";
export {
  bindQueryRenderSkeleton,
  compileQueryRenderSkeleton,
  createDatabase,
  renderQuery,
  sql,
} from "./query.js";
export type { IndexedTable, ResolverType } from "./resolver.js";
export { closestName, ParameterCollector, ResolverSchemaIndex, unionTypeLiterals } from "./resolver.js";
export type {
  CompatibleResultSchema,
  QueryResultValidationFailure,
  QueryResultValidationIssue,
  QueryResultValidationOptions,
  StandardSchemaV1,
  StandardTypedV1,
} from "./result-validation.js";
export {
  hasQueryResultValidator,
  QueryResultValidationError,
  queryResultValidationSource,
  validateQueryResultRows,
  validateQueryResultStream,
} from "./result-validation.js";
export type {
  QueryRoute,
  QueryRoutePreference,
  QueryRouteSelection,
  QueryRoutingObserver,
  QuerySemanticResolver,
  ReplicaSelectionContext,
  ReplicaSelector,
  RoutedDatabase,
  RoutedDatabaseOptions,
  RoutedTransactionOptions,
  TransactionRetryContext,
  TransactionRetryEvent,
  TransactionRetryPolicy,
} from "./routing.js";
export { createRoutedDatabase, queryRoute, UnsafeReplicaRoutingError } from "./routing.js";
export type {
  QueryCardinality,
  QueryConnectionAffinity,
  QueryDependency,
  QueryDependencyAccess,
  QueryDependencyKind,
  QueryLocking,
  QueryOperation,
  QuerySemantics,
  QueryVolatility,
  SemanticEvidence,
  SemanticFact,
} from "./semantics.js";
export {
  defineQuerySemantics,
  mapQuerySemanticRanges,
  mergeQuerySemantics,
  QUERY_SEMANTICS_VERSION,
  unknownQuerySemantics,
} from "./semantics.js";
export type {
  ColumnSnapshot,
  DialectAnalysis,
  DialectCapabilities,
  DialectPlugin,
  DomainSnapshot,
  FunctionSnapshot,
  GeneratedSchemaMetadata,
  GeneratedSchemaSnapshot,
  LiveQueryVerificationEvidence,
  LiveQueryVerificationField,
  LiveQueryVerificationRequest,
  LiveQueryVerificationServer,
  LiveQueryVerifier,
  QueryPlanBudget,
  QueryPlanBudgetPolicy,
  QueryPlanCaptureRequest,
  QueryPlanEnvironment,
  QueryPlanEvidence,
  QueryPlanInspector,
  QueryPlanNode,
  QueryPlanSample,
  QueryPlanSampleProvider,
  QueryPlanSampleRequest,
  ResolvedColumn,
  ResolvedParameter,
  SchemaProvider,
  SchemaSnapshot,
  SourceRange,
  SqlDiagnostic,
  SqlDiagnosticFix,
  StructuralColumnSnapshot,
  StructuralConstraintSnapshot,
  StructuralRelationSnapshot,
  StructuralRoutineArgumentSnapshot,
  StructuralRoutineSnapshot,
  TableSnapshot,
  TypedSqlConfig,
} from "./types.js";
export {
  assertDialectPlugin,
  DIALECT_CONTRACT_VERSION,
  defineConfig,
  parameterTypeLiteral,
  rowTypeLiteral,
} from "./types.js";
