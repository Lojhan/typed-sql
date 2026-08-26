import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
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
  Database,
  DialectCapabilities,
  DialectPlugin,
  OptionalSqlFragment,
  Query,
  QueryExecutor,
  QueryParameters,
  QueryRow,
  RenderedQuery,
  SchemaSnapshot,
  SqlDiagnostic,
  SqlDiagnosticFix,
  SqlFragment,
  SqlRenderer,
  SqlSegment,
  SqlTag,
  TransactionRunner,
  TypedSqlConfig,
} from "../../packages/core/src/index.js";
import * as coreApi from "../../packages/core/src/index.js";
import * as mysqlApi from "../../packages/mysql/src/index.js";
import * as mysql2Api from "../../packages/mysql/src/mysql2.js";
import type { MySqlDatabase } from "../../packages/mysql/src/runtime.js";
import * as mysqlRuntimeApi from "../../packages/mysql/src/runtime.js";
import * as postgresApi from "../../packages/postgres/src/index.js";
import * as pgApi from "../../packages/postgres/src/pg.js";
import type { PostgresDatabase } from "../../packages/postgres/src/runtime.js";
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

type PostgresAdapter = Awaited<ReturnType<typeof pgApi.createPgDatabase>>;
type MySqlAdapter = Awaited<ReturnType<typeof mysql2Api.createMySql2Database>>;
const postgresAdapter: Assert<Equal<PostgresAdapter, PostgresDatabase>> = true;
const mysqlAdapter: Assert<Equal<MySqlAdapter, MySqlDatabase>> = true;

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
  | DialectCapabilities
  | DialectPlugin
  | OptionalSqlFragment
  | QueryExecutor
  | RenderedQuery
  | SqlFragment
  | SqlDiagnostic
  | SqlDiagnosticFix
  | SqlRenderer
  | SqlSegment
  | SqlTag
  | TransactionRunner
  | TypedSqlConfig;

void queryRow;
void queryParameters;
void rowInvariant;
void parametersInvariant;
void composedParameters;
void emptyParameters;
void executionContract;
void postgresAdapter;
void mysqlAdapter;
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
  ],
  compiler: ["checkFile", "compileSource", "extractStaticQueries", "mapSqlRange"],
  config: ["discoverConfig", "fromConfig", "loadConfig"],
  core: [
    "assertDialectPlugin",
    "DIALECT_CONTRACT_VERSION",
    "ParameterCollector",
    "ResolverSchemaIndex",
    "closestName",
    "createDatabase",
    "defineConfig",
    "diagnosticRegistry",
    "isTypedSqlDiagnosticCode",
    "parameterTypeLiteral",
    "renderQuery",
    "rowTypeLiteral",
    "sql",
    "unionTypeLiterals",
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
  pg: ["adaptPgPool", "createPgDatabase", "loadPgDriver", "pg"],
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
      config: Object.keys(configApi).sort(),
      core: Object.keys(coreApi).sort(),
      mysql: Object.keys(mysqlApi).sort(),
      mysql2: Object.keys(mysql2Api).sort(),
      mysqlRuntime: Object.keys(mysqlRuntimeApi).sort(),
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
    strict.ok(!coreIndex.includes("SqlPartsParameters"));
    strict.ok(!coreIndex.includes("FragmentListParameters"));
    strict.ok(!compilerIndex.includes("StructuralExpansion"));
    strict.ok(!compilerIndex.includes("structuralRowType"));
    strict.ok(!compilerIndex.includes("extractAppendFragments"));
    for (const index of [coreIndex, astIndex, schemaIndex, compilerIndex]) {
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
