import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import type { SqlAstContext, SqlAstVisitor } from "../../packages/ast/src/index.js";
import * as astApi from "../../packages/ast/src/index.js";
import type {
  CheckFileOptions,
  CheckFileResult,
  CompiledFragment,
  CompiledQuery,
  CompileSourceOptions,
  CompileSourceResult,
  ExtractedInterpolation,
  ExtractedQuery,
  TypeScriptCheckResult,
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
  GrammarPerformanceOptions,
  GrammarPerformanceResult,
  GrammarPolicyProbe,
  GrammarSemanticExpectation,
  GrammarStructuralProbe,
  GrammarUnsupportedProbe,
  RequiredGrammarProbe,
  RuntimeAdapterConformanceFixture,
} from "../../packages/conformance/src/index.js";
import * as conformanceApi from "../../packages/conformance/src/index.js";
import type {
  ActiveDatabaseObservation,
  BatchOperationStart,
  ControlledQueryExecutor,
  Database,
  DatabaseObservation,
  DatabaseObservationStatus,
  DatabaseObserver,
  DatabaseOperationCompletion,
  DatabaseOperationEnd,
  DatabaseOperationStart,
  DialectCapabilities,
  DialectPlugin,
  ExecutionCapabilities,
  ExecutionCapability,
  ExecutionOptions,
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
  QueryRow,
  QuerySemantics,
  QueryStream,
  QueryVolatility,
  RenderedQuery,
  SchemaSnapshot,
  SemanticEvidence,
  SemanticFact,
  SqlDiagnostic,
  SqlDiagnosticFix,
  SqlFragment,
  SqlRenderer,
  SqlSegment,
  SqlTag,
  StreamOperationStart,
  StreamOptions,
  TransactionDatabase,
  TransactionOperationStart,
  TransactionRunner,
  TypedSqlConfig,
} from "../../packages/core/src/index.js";
import * as coreApi from "../../packages/core/src/index.js";
import * as mysqlApi from "../../packages/mysql/src/index.js";
import * as mysql2Api from "../../packages/mysql/src/mysql2.js";
import type { MySqlDatabase, MySqlPreparedQueryFactory, MySqlTransaction } from "../../packages/mysql/src/runtime.js";
import * as mysqlRuntimeApi from "../../packages/mysql/src/runtime.js";
import type { OpenTelemetryObserverOptions } from "../../packages/opentelemetry/src/index.js";
import * as openTelemetryApi from "../../packages/opentelemetry/src/index.js";
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

const base = coreApi.sql<Account, readonly []>`SELECT account.id, account.status FROM account`;
const predicate = coreApi.sql.fragment`account.id >= ${1n}`;
const composed = coreApi.sql.where(base, predicate);
const composedParameters: Assert<Equal<QueryParameters<typeof composed>, readonly [bigint]>> = true;
const emptyParameters: Assert<Equal<QueryParameters<ReturnType<typeof structuralEmptyContract>>, readonly []>> = true;

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
  | CheckFileOptions
  | CheckFileResult
  | CompiledFragment
  | CompiledQuery
  | CompileSourceOptions<SchemaSnapshot, unknown>
  | CompileSourceResult
  | ExtractedInterpolation
  | ExtractedQuery
  | TypeScriptCheckResult
  | CodecConformanceCase<unknown, unknown>
  | CodecConformanceFixture<unknown, unknown>
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
  | ControlledQueryExecutor
  | ActiveDatabaseObservation
  | BatchOperationStart
  | DatabaseObservation
  | DatabaseObservationStatus
  | DatabaseObserver
  | DatabaseOperationCompletion
  | DatabaseOperationEnd
  | DatabaseOperationStart
  | DialectCapabilities
  | DialectPlugin
  | ExecutionCapabilities
  | ExecutionCapability
  | ExecutionOptions
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
  | QuerySemantics
  | QueryVolatility
  | QueryBatch<readonly [ExactQuery]>
  | QueryCancellationReason
  | QueryCardinalityExpectation
  | QueryExecutor
  | QueryRenderSkeleton
  | QueryStream<Account>
  | RenderedQuery
  | SqlFragment
  | SqlDiagnostic
  | SqlDiagnosticFix
  | SqlRenderer
  | SqlSegment
  | SqlTag
  | SqlAstVisitor
  | SqlAstContext
  | StreamOptions
  | StreamOperationStart
  | SemanticEvidence
  | SemanticFact<string>
  | TransactionDatabase
  | TransactionRunner
  | TransactionOperationStart
  | TypedSqlConfig;

void queryRow;
void queryParameters;
void queryResult;
void queryResults;
void rowInvariant;
void parametersInvariant;
void composedParameters;
void emptyParameters;
void executionContract;
void governedExecutionContract;
void defaultTransactionContract;
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
  compiler: ["checkFile", "compileSource", "extractStaticQueries", "mapSqlRange"],
  conformance: [
    "GRAMMAR_CONFORMANCE_VERSION",
    "REQUIRED_GRAMMAR_PROBES",
    "assertCodecConformance",
    "assertGrammarConformance",
    "assertRuntimeAdapterConformance",
    "defineCodecConformanceFixture",
    "defineGrammarConformanceFixture",
    "measureGrammarPerformance",
  ],
  config: ["discoverConfig", "fromConfig", "loadConfig"],
  core: [
    "QueryCancelledError",
    "QueryCardinalityError",
    "UnsupportedExecutionCapabilityError",
    "assertDialectPlugin",
    "assertExecutionCapabilities",
    "bindQueryRenderSkeleton",
    "compileQueryRenderSkeleton",
    "DIALECT_CONTRACT_VERSION",
    "ParameterCollector",
    "ResolverSchemaIndex",
    "closestName",
    "createDatabase",
    "defineConfig",
    "defineQuerySemantics",
    "databaseErrorCompletion",
    "diagnosticRegistry",
    "executionDeadline",
    "isTypedSqlDiagnosticCode",
    "mapQuerySemanticRanges",
    "mergeQuerySemantics",
    "observeQueryStream",
    "parameterTypeLiteral",
    "QUERY_SEMANTICS_VERSION",
    "renderQuery",
    "rowTypeLiteral",
    "runControlledExecution",
    "sql",
    "startDatabaseObservation",
    "unionTypeLiterals",
    "unknownQuerySemantics",
  ],
  mysql: [
    "MYSQL_DIALECT_VERSION",
    "MySqlSchemaProvider",
    "defaultMySqlTypePolicy",
    "introspectMySql",
    "isKnownMySqlType",
    "mapMySqlType",
    "mysql",
    "mysqlCatalogQueries",
    "parseSchemaSnapshot",
    "sql",
    "typePolicy",
  ],
  mysql2: ["adaptMySql2Pool", "createMySql2Database", "loadMySql2Driver", "mysql2"],
  mysqlRuntime: ["createMySqlDatabase", "mysqlRenderer"],
  opentelemetry: ["createOpenTelemetryObserver"],
  postgres: [
    "POSTGRES_DIALECT_VERSION",
    "PostgresSchemaProvider",
    "defaultPostgresTypePolicy",
    "introspectPostgres",
    "isKnownPostgresType",
    "loadPostgresDriver",
    "mapPostgresType",
    "parseSchemaSnapshot",
    "postgres",
    "postgresCatalogQueries",
    "sql",
    "typePolicy",
  ],
  pg: ["adaptPgPool", "createPgDatabase", "loadPgCursorDriver", "loadPgDriver", "pg"],
  postgresRuntime: ["createPostgresDatabase", "createPostgresTypeParsers", "postgresRenderer"],
  schema: [
    "SCHEMA_FORMAT_VERSION",
    "calculateSchemaHash",
    "calculateTypePolicyHash",
    "checkSchemaDrift",
    "generateSchemaPackage",
    "loadGeneratedSchemaSnapshot",
    "loadSchemaSnapshot",
    "loadTypePolicy",
    "migrateSchemaSnapshot",
    "parseSchemaSnapshot",
    "parseTypePolicy",
  ],
} as const;

await describe("stable public API", async () => {
  await it("freezes package-root and driver-adapter runtime exports", () => {
    const actual = {
      ast: Object.keys(astApi).sort(),
      compiler: Object.keys(compilerApi).sort(),
      conformance: Object.keys(conformanceApi).sort(),
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
