import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import type { SelectLockingClause, SqlAstContext, SqlAstVisitor } from "../../packages/ast/src/index.js";
import * as astApi from "../../packages/ast/src/index.js";
import * as astToolkitApi from "../../packages/ast/src/toolkit/index.js";
import type {
  AnalyzeSchemaCompatibilityOptions,
  BuildQueryManifestOptions,
  BuildQueryManifestResult,
  CheckFileOptions,
  CheckFileResult,
  CollectQueryVerificationCandidatesOptions,
  CompatibilityClassification,
  CompatibilityEvidence,
  CompatibilityEvidenceValue,
  CompatibilityQueryReference,
  CompatibilitySeverity,
  CompiledFragment,
  CompiledQuery,
  CompiledQueryVariant,
  CompileSourceOptions,
  CompileSourceResult,
  DeploymentDirection,
  ExtractedDynamicQuery,
  ExtractedInterpolation,
  ExtractedQuery,
  ListProjectSourceFilesOptions,
  QueryManifest,
  QueryManifestBuildStats,
  QueryManifestCapabilityEvidence,
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
  QueryVerificationCandidate,
  QueryVerificationEvidence,
  QueryVerificationExpectedField,
  QueryVerificationMismatch,
  QueryVerificationMismatchKind,
  QueryVerificationProof,
  QueryVerificationProofEntry,
  ResolvedQueryManifestEntry,
  SchemaCompatibilityAssessment,
  SchemaCompatibilityChange,
  SchemaCompatibilityChangeKind,
  SchemaCompatibilityReport,
  SchemaCompatibilityTarget,
  TypeScriptCheckResult,
  UnresolvedQueryManifestEntry,
  VerifyQueryManifestOptions,
  VerifyQueryManifestResult,
} from "../../packages/compiler/src/index.js";
import * as compilerApi from "../../packages/compiler/src/index.js";
import * as configApi from "../../packages/config/src/index.js";
import type {
  CodecConformanceCase,
  CodecConformanceFixture,
  GrammarAnalysisProbe,
  GrammarCapabilityProbe,
  GrammarConformanceFixture,
  GrammarConformanceReport,
  GrammarDependencyExpectation,
  GrammarDialectPolicy,
  GrammarFeatureCategory,
  GrammarFeatureEntry,
  GrammarFeatureLedger,
  GrammarFeatureScope,
  GrammarFeatureSource,
  GrammarFeatureSupport,
  GrammarFeatureSupportLevel,
  GrammarPerformanceOptions,
  GrammarPerformanceResult,
  GrammarPolicyProbe,
  GrammarSemanticExpectation,
  GrammarStructuralProbe,
  GrammarUnsupportedProbe,
  GrammarVersionRange,
  GrammarVersionScheme,
  RequiredGrammarProbe,
  RuntimeAdapterConformanceFixture,
  VersionedCapabilityConformanceFixture,
  VersionedCapabilityExpectation,
  VersionedCapabilityProbe,
} from "../../packages/conformance/src/index.js";
import * as conformanceApi from "../../packages/conformance/src/index.js";
import * as conformanceV2Api from "../../packages/conformance/src/v2/index.js";
import type {
  ActiveDatabaseObservation,
  AdapterCapability,
  AdapterCapabilityHost,
  AdapterCapabilityResolver,
  AdapterCapabilityService,
  BatchOperationStart,
  BooleanDialectCapabilities,
  ControlledQueryExecutor,
  Database,
  DatabaseObservation,
  DatabaseObservationStatus,
  DatabaseObserver,
  DatabaseOperationCompletion,
  DatabaseOperationEnd,
  DatabaseOperationStart,
  DialectCapabilities,
  DialectCapabilityEvidence,
  DialectCapabilityEvidenceKind,
  DialectCapabilityHost,
  DialectCapabilityIssue,
  DialectCapabilityLevel,
  DialectCapabilityState,
  DialectCapabilityStates,
  DialectPlugin,
  DialectServerEvidence,
  DialectServerSetting,
  ExecutionCapabilities,
  ExecutionCapability,
  ExecutionOptions,
  LiveQueryVerificationEvidence,
  LiveQueryVerificationField,
  LiveQueryVerificationRequest,
  LiveQueryVerificationServer,
  LiveQueryVerifier,
  OptionalSqlFragment,
  Query,
  QueryBatch,
  QueryCancellationReason,
  QueryCardinality,
  QueryCardinalityExpectation,
  QueryConnectionAffinity,
  QueryDependency,
  QueryDependencyAccess,
  QueryDependencyKind,
  QueryExecutor,
  QueryLocking,
  QueryObservationCardinality,
  QueryOperation,
  QueryOperationStart,
  QueryParameters,
  QueryRenderSkeleton,
  QueryResult,
  QueryResults,
  QueryResultValidationFailure,
  QueryResultValidationIssue,
  QueryResultValidationOptions,
  QueryRoute,
  QueryRoutePreference,
  QueryRouteSelection,
  QueryRoutingObserver,
  QueryRow,
  QuerySemanticResolver,
  QuerySemantics,
  QueryStream,
  QueryVolatility,
  RenderedQuery,
  ReplicaSelectionContext,
  ReplicaSelector,
  RoutedDatabase,
  RoutedDatabaseOptions,
  RoutedTransactionOptions,
  SchemaSnapshot,
  SemanticEvidence,
  SemanticFact,
  SqlDiagnostic,
  SqlDiagnosticFix,
  SqlFragment,
  SqlRenderer,
  SqlSegment,
  SqlTag,
  StandardSchemaV1,
  StandardTypedV1,
  StreamOperationStart,
  StreamOptions,
  TransactionDatabase,
  TransactionOperationStart,
  TransactionRetryContext,
  TransactionRetryEvent,
  TransactionRetryPolicy,
  TransactionRunner,
  TypedSqlConfig,
} from "../../packages/core/src/index.js";
import * as coreApi from "../../packages/core/src/index.js";
import type {
  MySqlBulkCapability,
  MySqlBulkProgress,
  MySqlBulkResult,
  MySqlLoadDataOptions,
  MySqlQuerySemanticResolverOptions,
  MySqlRoutedDatabaseOptions,
} from "../../packages/mysql/src/index.js";
import * as mysqlApi from "../../packages/mysql/src/index.js";
import * as mysql2Api from "../../packages/mysql/src/mysql2.js";
import type { MySqlDatabase, MySqlPreparedQueryFactory, MySqlTransaction } from "../../packages/mysql/src/runtime.js";
import * as mysqlRuntimeApi from "../../packages/mysql/src/runtime.js";
import type { OpenTelemetryObserverOptions } from "../../packages/opentelemetry/src/index.js";
import * as openTelemetryApi from "../../packages/opentelemetry/src/index.js";
import type {
  PostgresCopyCapability,
  PostgresCopyFromOptions,
  PostgresCopyProgress,
  PostgresCopyResult,
  PostgresCopyToOptions,
  PostgresQuerySemanticResolverOptions,
  PostgresRoutedDatabaseOptions,
} from "../../packages/postgres/src/index.js";
import * as postgresApi from "../../packages/postgres/src/index.js";
import * as pgApi from "../../packages/postgres/src/pg.js";
import type {
  PostgresDatabase,
  PostgresPreparedQueryFactory,
  PostgresTransaction,
} from "../../packages/postgres/src/runtime.js";
import * as postgresRuntimeApi from "../../packages/postgres/src/runtime.js";
import * as schemaApi from "../../packages/schema/src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;
type Assignable<Source, Target> = [Source] extends [Target] ? true : false;

type Account = { readonly id: bigint; readonly status: "active" | "suspended" };
type ExactQuery = Query<Account, readonly [bigint]>;

const queryRow: Assert<Equal<QueryRow<ExactQuery>, Account>> = true;
const queryParameters: Assert<Equal<QueryParameters<ExactQuery>, readonly [bigint]>> = true;
const queryResult: Assert<Equal<QueryResult<ExactQuery>, readonly Account[]>> = true;
const queryResults: Assert<
  Equal<QueryResults<readonly [ExactQuery, ExactQuery]>, readonly [readonly Account[], readonly Account[]]>
> = true;
const rowInvariant: Assert<Equal<Assignable<ExactQuery, Query<{ readonly id: bigint }, readonly [bigint]>>, false>> =
  true;
const parametersInvariant: Assert<Equal<Assignable<ExactQuery, Query<Account, readonly [unknown]>>, false>> = true;

type CapabilityService = { readonly execute: (value: bigint) => Promise<void> };
const capability = coreApi.defineAdapterCapability<CapabilityService>("contract.execute");
const capabilityService: Assert<Equal<AdapterCapabilityService<typeof capability>, CapabilityService>> = true;
const capabilityResolver: AdapterCapabilityResolver = coreApi.createAdapterCapabilityResolver([
  [capability, { execute: async () => undefined }],
]);
const capabilityHost: AdapterCapabilityHost = { [coreApi.adapterCapabilities]: capabilityResolver };
const optionalCapability: CapabilityService | undefined = coreApi.getAdapterCapability(capabilityHost, capability);
const requiredCapability: CapabilityService = coreApi.requireAdapterCapability(capabilityHost, capability);
const hasCapability: boolean = coreApi.hasAdapterCapability(capabilityHost, capability);

const base = coreApi.sql<Account, readonly []>`SELECT account.id, account.status FROM account`;
const predicate = coreApi.sql.fragment`account.id >= ${1n}`;
const composed = coreApi.sql.where(base, predicate);
const composedParameters: Assert<Equal<QueryParameters<typeof composed>, readonly [bigint]>> = true;
const emptyParameters: Assert<Equal<QueryParameters<ReturnType<typeof structuralEmptyContract>>, readonly []>> = true;

function resultValidationContract(
  accountResultSchema: StandardSchemaV1<unknown, Account>,
  incompatibleResultSchema: StandardSchemaV1<unknown, { readonly id: string }>,
  anyResultSchema: StandardSchemaV1<unknown, ReturnType<typeof JSON.parse>>,
) {
  const validatedResultQuery = coreApi.sql.validateResult(base, accountResultSchema);
  const validatedResultRow: Assert<Equal<QueryRow<typeof validatedResultQuery>, Account>> = true;
  const validatedResultParameters: Assert<Equal<QueryParameters<typeof validatedResultQuery>, readonly []>> = true;
  // @ts-expect-error validator output must be assignable to the compiler-inferred query row
  coreApi.sql.validateResult(base, incompatibleResultSchema);
  // @ts-expect-error `any` cannot provide a sound runtime validation boundary
  coreApi.sql.validateResult(base, anyResultSchema);
  void validatedResultRow;
  void validatedResultParameters;
}

function structuralEmptyContract() {
  return coreApi.sql`SELECT 1${coreApi.sql.empty}`;
}

function executionContract(database: Database, query: ExactQuery): Promise<readonly Account[]> {
  return database.execute(query);
}

async function governedExecutionContract(database: Database, query: ExactQuery): Promise<void> {
  const all: readonly Account[] = await database.all(query, { deadline: new Date(Date.now() + 1_000) });
  const one: Account = await database.one(query, { signal: new AbortController().signal });
  const maybeOne: Account | undefined = await database.maybeOne(query);
  const capabilities: ExecutionCapabilities = database.executionCapabilities;
  void all;
  void one;
  void maybeOne;
  void capabilities;
}

function defaultTransactionContract(database: Database, query: ExactQuery): Promise<readonly Account[]> {
  return database.transaction(async (transaction) => {
    const compatible: Database = transaction;
    void compatible;
    return transaction.execute(query);
  });
}

interface EnrichedTransaction extends Database<EnrichedTransaction> {
  explain<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<string>;
}

interface EnrichedDatabase extends Database<EnrichedTransaction> {
  close(): Promise<void>;
}

function enrichedTransactionContract(database: EnrichedDatabase, query: ExactQuery): Promise<string> {
  return database.transaction(async (transaction) => {
    const retainedCapability: Promise<string> = transaction.explain(query);
    await transaction.transaction(async (nested) => {
      const nestedCapability: Promise<string> = nested.explain(query);
      void nestedCapability;
    });
    // @ts-expect-error transaction scopes retain adapter capabilities without exposing root lifecycle methods
    await transaction.close();
    return retainedCapability;
  });
}

const enrichedIsDefaultCompatible: Assert<Assignable<EnrichedDatabase, Database>> = true;

type PostgresAdapter = Awaited<ReturnType<typeof pgApi.createPgDatabase>>;
type MySqlAdapter = Awaited<ReturnType<typeof mysql2Api.createMySql2Database>>;
const postgresAdapter: Assert<Equal<PostgresAdapter, PostgresDatabase>> = true;
const mysqlAdapter: Assert<Equal<MySqlAdapter, MySqlDatabase>> = true;
type PostgresTransactionScope = Parameters<Parameters<PostgresDatabase["transaction"]>[0]>[0];
type MySqlTransactionScope = Parameters<Parameters<MySqlDatabase["transaction"]>[0]>[0];
const postgresTransaction: Assert<Equal<PostgresTransactionScope, PostgresTransaction>> = true;
const mysqlTransaction: Assert<Equal<MySqlTransactionScope, MySqlTransaction>> = true;
const postgresTransactionOmitsClose: Assert<Equal<Extract<keyof PostgresTransaction, "close">, never>> = true;
const mysqlTransactionOmitsClose: Assert<Equal<Extract<keyof MySqlTransaction, "close">, never>> = true;

function postgresPreparedContract(database: PostgresDatabase): ExactQuery {
  const prepared = database.prepare(
    "account-by-id",
    (id: bigint) =>
      coreApi.sql.__typed<
        Account,
        readonly [bigint]
      >()`SELECT account.id, account.status FROM account WHERE account.id = ${id}`,
  );
  const exact: Assert<Equal<typeof prepared, PostgresPreparedQueryFactory<[id: bigint], Account, readonly [bigint]>>> =
    true;
  void exact;
  return prepared(1n);
}

function mysqlPreparedContract(database: MySqlDatabase): ExactQuery {
  const prepared = database.prepare(
    "account-by-id",
    (id: bigint) =>
      coreApi.sql.__typed<
        Account,
        readonly [bigint]
      >()`SELECT account.id, account.status FROM account WHERE account.id = ${id}`,
  );
  const exact: Assert<Equal<typeof prepared, MySqlPreparedQueryFactory<[id: bigint], Account, readonly [bigint]>>> =
    true;
  void exact;
  return prepared(1n);
}

interface BulkAccountInput {
  readonly id: bigint;
  readonly email: string;
  readonly note: string | null;
}

const bulkAccountQuery = (row: BulkAccountInput) =>
  coreApi.sql.__typed<never, readonly [bigint, string, string | null]>()`
    INSERT INTO account (id, email, note) VALUES (${row.id}, ${row.email}, ${row.note})
  `;

function postgresCopyContract(database: PostgresDatabase): Promise<PostgresCopyResult> {
  const copy = coreApi.requireAdapterCapability(database, postgresApi.postgresCopy);
  void copy.copyTo(coreApi.sql.__typed<Account, readonly []>()`SELECT id, status FROM account`);
  // @ts-expect-error COPY input rows retain the INSERT factory's scalar and nullability contract
  void copy.copyFrom(bulkAccountQuery, [{ id: "1", email: "wrong@example.com", note: undefined }]);
  // @ts-expect-error COPY TO cannot turn a parameterized query into a static export
  void copy.copyTo(coreApi.sql.__typed<Account, readonly [bigint]>()`SELECT id, status FROM account WHERE id = ${1n}`);
  return copy.copyFrom(bulkAccountQuery, [{ id: 1n, email: "one@example.com", note: null }]);
}

function mysqlBulkContract(database: MySqlDatabase): Promise<MySqlBulkResult> {
  const bulk = coreApi.requireAdapterCapability(database, mysqlApi.mysqlBulk);
  // @ts-expect-error LOAD DATA input rows retain the INSERT factory's scalar and nullability contract
  void bulk.loadData(bulkAccountQuery, [{ id: 1n, email: 42, note: undefined }]);
  return bulk.loadData(bulkAccountQuery, [{ id: 1n, email: "one@example.com", note: null }]);
}

function postgresStreamingContract(database: PostgresDatabase, query: ExactQuery): QueryStream<Account> {
  const stream = database.stream(query, { batchSize: 256 });
  const exact: Assert<Equal<typeof stream, QueryStream<Account>>> = true;
  void exact;
  return stream;
}

function mysqlStreamingContract(database: MySqlDatabase, query: ExactQuery): QueryStream<Account> {
  const stream = database.stream(query, { batchSize: 256 });
  const exact: Assert<Equal<typeof stream, QueryStream<Account>>> = true;
  void exact;
  return stream;
}

async function transactionStreamingContract(
  postgres: PostgresDatabase,
  mysql: MySqlDatabase,
  query: ExactQuery,
): Promise<void> {
  await postgres.transaction(async (transaction) => {
    const exact: QueryStream<Account> = transaction.stream(query);
    await exact.close();
  });
  await mysql.transaction(async (transaction) => {
    const exact: QueryStream<Account> = transaction.stream(query);
    await exact.close();
  });
}

function postgresBatchContract(
  database: PostgresDatabase,
  query: ExactQuery,
): Promise<readonly [readonly Account[], readonly Account[]]> {
  const results = database.batch([query, query]);
  const exact: Assert<Equal<typeof results, Promise<readonly [readonly Account[], readonly Account[]]>>> = true;
  void exact;
  // @ts-expect-error every ordered batch member must be a typed Query
  void database.batch([query, "not a query"]);
  return results;
}

function mysqlBatchContract(
  database: MySqlDatabase,
  query: ExactQuery,
): Promise<readonly [readonly Account[], readonly Account[]]> {
  const results = database.batch([query, query]);
  const exact: Assert<Equal<typeof results, Promise<readonly [readonly Account[], readonly Account[]]>>> = true;
  void exact;
  // @ts-expect-error every ordered batch member must be a typed Query
  void database.batch([query, 42]);
  return results;
}

async function transactionBatchContract(
  postgres: PostgresDatabase,
  mysql: MySqlDatabase,
  query: ExactQuery,
): Promise<void> {
  await postgres.transaction(async (transaction) => {
    const exact: readonly [readonly Account[]] = await transaction.batch([query]);
    void exact;
  });
  await mysql.transaction(async (transaction) => {
    const exact: readonly [readonly Account[]] = await transaction.batch([query]);
    void exact;
  });
}

type ReferencedStableTypes =
  | AnalyzeSchemaCompatibilityOptions
  | CheckFileOptions
  | CheckFileResult
  | BuildQueryManifestOptions<SchemaSnapshot, unknown>
  | BuildQueryManifestResult
  | CompiledFragment
  | CompiledQuery
  | CompiledQueryVariant
  | CompileSourceOptions<SchemaSnapshot, unknown>
  | CompileSourceResult
  | ExtractedDynamicQuery
  | ExtractedInterpolation
  | ExtractedQuery
  | ListProjectSourceFilesOptions
  | CollectQueryVerificationCandidatesOptions<SchemaSnapshot, unknown>
  | CompatibilityClassification
  | CompatibilityEvidence
  | CompatibilityEvidenceValue
  | CompatibilityQueryReference
  | CompatibilitySeverity
  | DeploymentDirection
  | QueryManifest
  | QueryManifestBuildStats
  | QueryManifestCapabilityEvidence
  | QueryManifestColumn
  | QueryManifestDiagnostic
  | QueryManifestEntry
  | QueryManifestLocation
  | QueryManifestParameter
  | QueryManifestSemanticEvidence
  | QueryManifestSemanticFact
  | QueryManifestSemantics
  | QueryManifestSource
  | QueryManifestSourceInput
  | QueryManifestVariant
  | QueryVerificationCandidate
  | QueryVerificationEvidence
  | QueryVerificationExpectedField
  | QueryVerificationMismatch
  | QueryVerificationMismatchKind
  | QueryVerificationProof
  | QueryVerificationProofEntry
  | SchemaCompatibilityAssessment
  | SchemaCompatibilityChange
  | SchemaCompatibilityChangeKind
  | SchemaCompatibilityReport
  | SchemaCompatibilityTarget
  | ResolvedQueryManifestEntry
  | UnresolvedQueryManifestEntry
  | VerifyQueryManifestOptions
  | VerifyQueryManifestResult
  | TypeScriptCheckResult
  | CodecConformanceCase<unknown, unknown>
  | CodecConformanceFixture<unknown, unknown>
  | GrammarDialectPolicy
  | GrammarFeatureCategory
  | GrammarFeatureEntry
  | GrammarFeatureLedger
  | GrammarFeatureScope
  | GrammarFeatureSource
  | GrammarFeatureSupport
  | GrammarFeatureSupportLevel
  | GrammarVersionRange
  | GrammarVersionScheme
  | GrammarAnalysisProbe
  | GrammarCapabilityProbe
  | GrammarConformanceFixture<SchemaSnapshot, unknown>
  | GrammarConformanceReport
  | GrammarDependencyExpectation
  | GrammarPerformanceOptions<SchemaSnapshot, unknown>
  | GrammarPerformanceResult
  | GrammarPolicyProbe<unknown>
  | GrammarSemanticExpectation
  | GrammarStructuralProbe
  | GrammarUnsupportedProbe
  | RequiredGrammarProbe
  | RuntimeAdapterConformanceFixture<Account, readonly [bigint]>
  | VersionedCapabilityConformanceFixture<SchemaSnapshot, unknown>
  | VersionedCapabilityExpectation
  | VersionedCapabilityProbe<SchemaSnapshot, unknown>
  | ControlledQueryExecutor
  | ActiveDatabaseObservation
  | AdapterCapability<CapabilityService>
  | AdapterCapabilityHost
  | AdapterCapabilityResolver
  | AdapterCapabilityService<typeof capability>
  | BatchOperationStart
  | DatabaseObservation
  | DatabaseObservationStatus
  | DatabaseObserver
  | DatabaseOperationCompletion
  | DatabaseOperationEnd
  | DatabaseOperationStart
  | BooleanDialectCapabilities
  | DialectCapabilityEvidence
  | DialectCapabilityEvidenceKind
  | DialectCapabilityHost<SchemaSnapshot>
  | DialectCapabilityIssue
  | DialectCapabilityLevel
  | DialectCapabilityState
  | DialectCapabilityStates
  | DialectCapabilities
  | DialectPlugin
  | DialectServerEvidence
  | DialectServerSetting
  | ExecutionCapabilities
  | ExecutionCapability
  | ExecutionOptions
  | LiveQueryVerificationEvidence
  | LiveQueryVerificationField
  | LiveQueryVerificationRequest
  | LiveQueryVerificationServer
  | LiveQueryVerifier
  | OptionalSqlFragment
  | OpenTelemetryObserverOptions
  | QueryCardinality
  | QueryConnectionAffinity
  | QueryDependency
  | QueryDependencyAccess
  | QueryDependencyKind
  | QueryLocking
  | QueryOperation
  | QueryObservationCardinality
  | QueryOperationStart
  | QueryRoute
  | QueryRoutePreference
  | QueryRouteSelection
  | QueryRoutingObserver
  | QuerySemanticResolver
  | QuerySemantics
  | QueryVolatility
  | QueryBatch<readonly [ExactQuery]>
  | QueryCancellationReason
  | QueryCardinalityExpectation
  | QueryExecutor
  | QueryRenderSkeleton
  | QueryResultValidationFailure
  | QueryResultValidationIssue
  | QueryResultValidationOptions
  | QueryStream<Account>
  | RenderedQuery
  | ReplicaSelectionContext
  | ReplicaSelector
  | RoutedDatabase
  | RoutedDatabaseOptions
  | RoutedTransactionOptions
  | SqlFragment
  | SqlDiagnostic
  | SqlDiagnosticFix
  | SqlRenderer
  | SqlSegment
  | SqlTag
  | SqlAstVisitor
  | SqlAstContext
  | SelectLockingClause
  | StreamOptions
  | StandardSchemaV1
  | StandardTypedV1
  | StreamOperationStart
  | SemanticEvidence
  | SemanticFact<string>
  | TransactionDatabase
  | TransactionRunner
  | TransactionOperationStart
  | TransactionRetryContext
  | TransactionRetryEvent
  | TransactionRetryPolicy
  | TypedSqlConfig
  | PostgresQuerySemanticResolverOptions
  | PostgresRoutedDatabaseOptions
  | PostgresCopyCapability
  | PostgresCopyFromOptions
  | PostgresCopyProgress
  | PostgresCopyResult
  | PostgresCopyToOptions
  | MySqlQuerySemanticResolverOptions
  | MySqlRoutedDatabaseOptions
  | MySqlBulkCapability
  | MySqlBulkProgress
  | MySqlBulkResult
  | MySqlLoadDataOptions;

void queryRow;
void queryParameters;
void queryResult;
void queryResults;
void rowInvariant;
void parametersInvariant;
void capabilityService;
void optionalCapability;
void requiredCapability;
void hasCapability;
void composedParameters;
void emptyParameters;
void executionContract;
void governedExecutionContract;
void defaultTransactionContract;
void resultValidationContract;
void enrichedTransactionContract;
void enrichedIsDefaultCompatible;
void postgresAdapter;
void mysqlAdapter;
void postgresTransaction;
void mysqlTransaction;
void postgresTransactionOmitsClose;
void mysqlTransactionOmitsClose;
void postgresPreparedContract;
void mysqlPreparedContract;
void postgresCopyContract;
void mysqlBulkContract;
void postgresStreamingContract;
void mysqlStreamingContract;
void transactionStreamingContract;
void postgresBatchContract;
void mysqlBatchContract;
void transactionBatchContract;
void (undefined as unknown as ReferencedStableTypes);

const expectedRuntimeExports = {
  ast: [
    "DEFAULT_MAX_PARSE_DEPTH",
    "DEFAULT_MAX_SQL_LENGTH",
    "DEFAULT_MAX_TOKENS",
    "SqlParseError",
    "SqlTokenizeError",
    "parseSelect",
    "parseStatement",
    "tokenize",
    "walkStatement",
  ],
  astToolkit: [
    "DEFAULT_MAX_PARSE_DEPTH",
    "DEFAULT_MAX_SQL_LENGTH",
    "DEFAULT_MAX_TOKENS",
    "SQL_PARSER_TOOLKIT_VERSION",
    "SqlToolkitError",
    "TokenCursor",
    "definePrecedenceTable",
    "defineSqlLexicalProfile",
    "mergeSourceRanges",
    "tokenizeSql",
    "walkTree",
  ],
  compiler: [
    "QUERY_FINGERPRINT_ALGORITHM",
    "QUERY_MANIFEST_FORMAT_VERSION",
    "QUERY_MANIFEST_JSON_SCHEMA",
    "QUERY_PLAN_CAPTURE_VERSION",
    "QUERY_PLAN_FORMAT_VERSION",
    "QUERY_PLAN_REVIEW_FORMAT_VERSION",
    "QUERY_VERIFICATION_FORMAT_VERSION",
    "QUERY_VERIFIER_VERSION",
    "SCHEMA_COMPATIBILITY_ANALYZER_VERSION",
    "SCHEMA_COMPATIBILITY_FORMAT_VERSION",
    "analyzeSchemaCompatibility",
    "assertQueryVerificationProofCurrent",
    "buildQueryManifest",
    "captureQueryPlans",
    "checkFile",
    "compileSource",
    "collectQueryVerificationCandidates",
    "extractDynamicQueries",
    "extractStaticQueries",
    "listProjectSourceFiles",
    "mapSqlRange",
    "parseQueryManifest",
    "parseQueryPlanArtifact",
    "parseQueryPlanReviewReport",
    "parseQueryVerificationProof",
    "parseSchemaCompatibilityReport",
    "reviewQueryPlans",
    "serializeQueryManifest",
    "serializeQueryPlanArtifact",
    "serializeQueryPlanReviewReport",
    "serializeQueryVerificationProof",
    "serializeSchemaCompatibilityReport",
    "verifyQueryManifest",
  ],
  conformance: [
    "FEATURE_LEDGER_FORMAT_VERSION",
    "GRAMMAR_CONFORMANCE_VERSION",
    "REQUIRED_GRAMMAR_PROBES",
    "assertCodecConformance",
    "assertGrammarConformance",
    "assertRuntimeAdapterConformance",
    "assertVersionedCapabilityConformance",
    "compareGrammarVersions",
    "defineCodecConformanceFixture",
    "defineGrammarConformanceFixture",
    "defineGrammarFeatureLedger",
    "featureSupport",
    "featureSupportAtVersion",
    "grammarVersionInRange",
    "measureGrammarPerformance",
    "parseGrammarFeatureLedger",
  ],
  conformanceV2: [
    "CONFORMANCE_LAYERS",
    "CONFORMANCE_REPORT_FORMAT_VERSION",
    "CONFORMANCE_VERSION",
    "adaptGrammarConformanceV1",
    "assertExactConformance",
    "createConformanceReport",
    "createConformanceReproductionBundle",
    "defineConformanceProbe",
    "defineConformanceSuite",
    "discoverConformanceFixtures",
    "formatConformanceReport",
    "minimizeConformanceSource",
    "runAdaptedGrammarConformanceV1",
    "runLiveConformanceProbe",
    "runStaticConformanceProbe",
    "selectExpectedOutcome",
    "serializeConformanceReport",
    "serializeConformanceReproductionBundle",
    "targetMatches",
  ],
  config: ["discoverConfig", "fromConfig", "loadConfig"],
  core: [
    "UnsupportedAdapterCapabilityError",
    "QueryCancelledError",
    "QueryCardinalityError",
    "QueryResultValidationError",
    "UnsupportedExecutionCapabilityError",
    "assertDialectPlugin",
    "assertExecutionCapabilities",
    "applyDialectCapabilityStates",
    "adapterCapabilities",
    "bindQueryRenderSkeleton",
    "compileQueryRenderSkeleton",
    "DIALECT_CONTRACT_VERSION",
    "ParameterCollector",
    "ResolverSchemaIndex",
    "closestName",
    "createDatabase",
    "createAdapterCapabilityResolver",
    "createRoutedDatabase",
    "defineAdapterCapability",
    "defineDialectCapabilityStates",
    "defineDialectServerEvidence",
    "defineConfig",
    "defineQuerySemantics",
    "databaseErrorCompletion",
    "dialectCapabilityIssues",
    "diagnosticRegistry",
    "executionDeadline",
    "getAdapterCapability",
    "hasAdapterCapability",
    "hasQueryResultValidator",
    "isTypedSqlDiagnosticCode",
    "mapQuerySemanticRanges",
    "mergeQuerySemantics",
    "observeQueryStream",
    "parameterTypeLiteral",
    "parseDialectServerEvidence",
    "queryRoute",
    "queryResultValidationSource",
    "QUERY_SEMANTICS_VERSION",
    "renderQuery",
    "resolveDialectCapabilityStates",
    "requireAdapterCapability",
    "rowTypeLiteral",
    "runControlledExecution",
    "sql",
    "startDatabaseObservation",
    "staticDialectCapabilityStates",
    "unionTypeLiterals",
    "unknownQuerySemantics",
    "UnsafeReplicaRoutingError",
    "validateQueryResultRows",
    "validateQueryResultStream",
  ],
  mysql: [
    "MYSQL_DIALECT_VERSION",
    "MYSQL_SUPPORT_POLICY",
    "MySqlSchemaProvider",
    "createMySqlQuerySemanticResolver",
    "createMySqlRoutedDatabase",
    "defaultMySqlTypePolicy",
    "introspectMySql",
    "isKnownMySqlType",
    "isMySqlRetryableTransactionError",
    "mapMySqlType",
    "mysql",
    "mysqlBulk",
    "mysqlCatalogQueries",
    "mySqlServerEvidence",
    "mySqlVersionSupport",
    "parseMySqlVersion",
    "parseSchemaSnapshot",
    "resolveMySqlCapabilities",
    "sql",
    "typePolicy",
  ],
  mysql2: [
    "adaptMySql2Pool",
    "createMySql2Database",
    "createMySql2LiveVerifier",
    "createMySql2PlanInspector",
    "loadMySql2Driver",
    "mysql2",
  ],
  mysqlRuntime: ["createMySqlDatabase", "mysqlRenderer"],
  opentelemetry: ["createOpenTelemetryObserver"],
  postgres: [
    "POSTGRES_DIALECT_VERSION",
    "POSTGRES_EXTENSION_MANIFEST_FORMAT_VERSION",
    "POSTGRES_CORE_CATALOG_FORMAT_VERSION",
    "POSTGRES_SUPPORT_POLICY",
    "PostgresExtensionResolutionError",
    "PostgresRuntimeCompatibilityError",
    "PostgresSchemaProvider",
    "createPostgresQuerySemanticResolver",
    "createPostgresRoutedDatabase",
    "defaultPostgresTypePolicy",
    "definePostgresExtensionManifest",
    "introspectPostgres",
    "introspectPostgresExtensionManifests",
    "isKnownPostgresType",
    "isPostgresRetryableTransactionError",
    "loadPostgresDriver",
    "mapPostgresType",
    "parseSchemaSnapshot",
    "parsePostgresMajor",
    "parsePostgresRuntimeSnapshot",
    "postgres",
    "postgresServerEvidence",
    "postgresVersionSupport",
    "postgresCopy",
    "postgresCoreCatalog",
    "postgresCatalogQueries",
    "resolvePostgresCapabilities",
    "resolvePostgresExtensionManifests",
    "sql",
    "typePolicy",
    "validatePostgresRuntimeCompatibility",
  ],
  pg: [
    "adaptPgPool",
    "createPgDatabase",
    "createPgLiveVerifier",
    "createPgPlanInspector",
    "loadPgCursorDriver",
    "loadPgCopyStreams",
    "loadPgDriver",
    "normalizePostgresAdapterError",
    "pg",
    "PostgresAdapterError",
    "readPgRuntimeServerEvidence",
    "resolvePgRuntimeCodecs",
  ],
  postgresRuntime: ["createPostgresDatabase", "createPostgresTypeParsers", "postgresRenderer"],
  schema: [
    "LEGACY_SCHEMA_FORMAT_VERSION",
    "SCHEMA_FORMAT_VERSION",
    "calculateSchemaHash",
    "calculateTypePolicyHash",
    "canonicalizeSchemaValue",
    "checkSchemaDrift",
    "defineSchemaSnapshotV2",
    "fingerprintSchemaExpression",
    "generateSchemaPackage",
    "loadGeneratedSchemaSnapshot",
    "loadSchemaSnapshot",
    "loadTypePolicy",
    "migrateSchemaSnapshot",
    "parseSchemaSnapshot",
    "parseTypePolicy",
    "serializeSchemaSnapshot",
    "upgradeSchemaSnapshotV1",
  ],
} as const;

await describe("stable public API", async () => {
  await it("freezes package-root and driver-adapter runtime exports", () => {
    const actual = {
      ast: Object.keys(astApi).sort(),
      astToolkit: Object.keys(astToolkitApi).sort(),
      compiler: Object.keys(compilerApi).sort(),
      conformance: Object.keys(conformanceApi).sort(),
      conformanceV2: Object.keys(conformanceV2Api).sort(),
      config: Object.keys(configApi).sort(),
      core: Object.keys(coreApi).sort(),
      mysql: Object.keys(mysqlApi).sort(),
      mysql2: Object.keys(mysql2Api).sort(),
      mysqlRuntime: Object.keys(mysqlRuntimeApi).sort(),
      opentelemetry: Object.keys(openTelemetryApi).sort(),
      postgres: Object.keys(postgresApi).sort(),
      pg: Object.keys(pgApi).sort(),
      postgresRuntime: Object.keys(postgresRuntimeApi).sort(),
      schema: Object.keys(schemaApi).sort(),
    };
    for (const name of Object.keys(expectedRuntimeExports) as (keyof typeof expectedRuntimeExports)[]) {
      strict.deepStrictEqual(actual[name], expectedRuntimeExports[name].slice().sort(), `${name} exports changed`);
    }
  });

  await it("keeps implementation-only type helpers out of package roots", async () => {
    const coreIndex = await readFile(new URL("../../packages/core/src/index.ts", import.meta.url), "utf8");
    const astIndex = await readFile(new URL("../../packages/ast/src/index.ts", import.meta.url), "utf8");
    const schemaIndex = await readFile(new URL("../../packages/schema/src/index.ts", import.meta.url), "utf8");
    const compilerIndex = await readFile(new URL("../../packages/compiler/src/index.ts", import.meta.url), "utf8");
    const conformanceIndex = await readFile(
      new URL("../../packages/conformance/src/index.ts", import.meta.url),
      "utf8",
    );
    strict.ok(!coreIndex.includes("SqlPartsParameters"));
    strict.ok(!coreIndex.includes("FragmentListParameters"));
    strict.ok(!compilerIndex.includes("StructuralExpansion"));
    strict.ok(!compilerIndex.includes("structuralRowType"));
    strict.ok(!compilerIndex.includes("extractAppendFragments"));
    for (const index of [coreIndex, astIndex, schemaIndex, compilerIndex, conformanceIndex]) {
      strict.ok(!index.includes("export type *"), "stable package roots must explicitly inventory type exports");
    }
  });

  await it("keeps query rows and ordered parameters immutable at runtime", () => {
    strict.ok(Object.isFrozen(base));
    strict.ok(Object.isFrozen(base.segments));
    strict.ok(Object.isFrozen(predicate));
    strict.ok(Object.isFrozen(composed));
  });
});
