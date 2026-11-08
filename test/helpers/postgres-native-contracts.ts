import { execFile as callback } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Query } from "@typed-sql/core";
import { Pool, type PoolClient } from "pg";
import { strict } from "poku";
import {
  acquireNativeProjectCatalog,
  acquireNativeQueryContract,
  applyProjectCatalogs,
  createAnalysisContextScope,
  createContractDialect,
  createLiveAnalysisScheduler,
  createNativeLiveAnalysisRunner,
  createPersistentLiveAnalysisRunner,
  createProjectCatalogClosure,
  createQueryContract,
  createStaticQueryClaim,
  exportQueryContracts,
  type LiveAnalysisState,
  loadFrozenContractView,
  loadQueryContracts,
  openAnalysisCache,
  parseContractQualificationPolicy,
  queryContractDigest,
  reconcileQueryContract,
} from "../../packages/analysis/src/index.js";
import { collectSourceQueryCandidates, compileSource } from "../../packages/compiler/src/index.js";
import { postgres, postgresServerEvidence } from "../../packages/postgres/src/analysis.js";
import { postgresContractIdentity } from "../../packages/postgres/src/contract-profile.js";
import { adaptPgPool, type PgLiveVerifierClient } from "../../packages/postgres/src/pg.js";
import {
  createPgNativeContractAdapter,
  PostgresContractAcquisitionError,
} from "../../packages/postgres/src/pg-contracts.js";
import { postgresProfile } from "../../packages/postgres/src/profile.js";
import { createPostgresProjectCatalogContribution } from "../../packages/postgres/src/project-catalog.js";
import { createPostgresContractReconciler } from "../../packages/postgres/src/reconciliation.js";
import { createPostgresDatabase } from "../../packages/postgres/src/runtime.js";
import { type RoutineSnapshot, upgradeSchemaSnapshotV1 } from "../../packages/schema/src/index.js";
import { assertIsolatedPostgresContractConsumer } from "./frozen-contract-consumer.js";
import { ProtocolClient } from "./protocol-client.js";
import { startWatchedCli } from "./watch-cli.js";

/** Real engine proof: independent description, compiled metadata, actual decoding and offline reuse. */
export async function assertPostgresNativeContracts(connectionString: string, directory: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 2 });
  const schema = { formatVersion: 1, dialect: "postgres", tables: {}, functions: {} } as const;
  const native = createPgNativeContractAdapter({ pool, schema });
  let temporary: string | undefined;
  const namespace = `typed_sql_contract_${process.pid}`;
  let created = false;
  try {
    const version = (await pool.query<{ version: string }>("SELECT current_setting('server_version') AS version"))
      .rows[0]!.version;
    if (!version.startsWith("18.")) {
      await strict.rejects(
        native.inspectContext(),
        (error: unknown) => error instanceof PostgresContractAcquisitionError && error.reason === "unsupported-context",
      );
      return;
    }
    await pool.query(`CREATE SCHEMA ${namespace}`);
    created = true;
    await pool.query(
      `CREATE TABLE ${namespace}.calls (count integer NOT NULL); INSERT INTO ${namespace}.calls VALUES (0)`,
    );
    await pool.query(
      `CREATE FUNCTION ${namespace}.increment(value bigint) RETURNS bigint LANGUAGE plpgsql AS $$BEGIN UPDATE ${namespace}.calls SET count = count + 1; RETURN value + 1; END$$`,
    );
    await pool.query(
      `CREATE FUNCTION ${namespace}.strict_null(value bigint) RETURNS bigint LANGUAGE sql IMMUTABLE STRICT AS $$SELECT NULL::bigint$$`,
    );
    await pool.query(
      `CREATE FUNCTION ${namespace}.format_type(value oid, modifier text) RETURNS text LANGUAGE plpgsql AS $$BEGIN UPDATE ${namespace}.calls SET count=count+1; RETURN 'wrong'; END$$`,
    );
    await pool.query(
      `CREATE FUNCTION ${namespace}.unnest(value oid[]) RETURNS SETOF oid LANGUAGE plpgsql AS $$BEGIN UPDATE ${namespace}.calls SET count=count+1; RETURN QUERY SELECT pg_catalog.unnest(value); END$$`,
    );
    const text = `SELECT ${namespace}.increment($1::bigint) AS result`;
    const source =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This is application source for the compiler proof.
      'import {sql} from "@typed-sql/postgres"; export function query(value:bigint){return sql`SELECT NAMESPACE.increment(${value}::bigint) AS result`;}';
    const application = source.replaceAll("NAMESPACE", namespace);
    const offlineBaseline = compileSource({ source: application, schema, dialect: postgres() });
    strict.ok(
      offlineBaseline.diagnostics.some((item) => item.severity === "error") ||
        offlineBaseline.queries.some((query) => query.rowType.includes("unknown")),
    );
    const profile = postgresProfile();
    const candidates = collectSourceQueryCandidates({ source: application, profile, schema });
    strict.equal(candidates.complete, true);
    strict.equal(candidates.candidates.length, 1);
    strict.equal(candidates.candidates[0]!.sql, text);
    const parameterOccurrences = candidates.candidates[0]!.parameterOccurrences;
    const context = await native.inspectContext();
    // Metadata acquisition now owns context observation and collection on one guarded lease.
    const projectBase = {
      ...upgradeSchemaSnapshotV1({
        ...schema,
        dialectVersion: context.grammar.version,
        server: postgresServerEvidence(version),
      }),
      dialect: "postgres" as const,
    };
    const projectNative = createPgNativeContractAdapter({
      schema: projectBase,
      pool: {
        async connect() {
          const client = await pool.connect();
          return {
            async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
              const result = await client.query<Row>(sql, values === undefined ? [] : [...values]);
              if (sql === "BEGIN READ ONLY")
                await client.query(`SET LOCAL search_path TO pg_catalog, ${namespace}, public`);
              return result;
            },
            release: client.release.bind(client),
          } as PgLiveVerifierClient;
        },
      },
    });
    const strictSql = `SELECT ${namespace}.strict_null(1::bigint) AS result`;
    let capture: Awaited<ReturnType<typeof acquireNativeProjectCatalog>>;
    for (let attempt = 0; ; attempt++) {
      try {
        capture = await acquireNativeProjectCatalog({ adapter: projectNative, sql: [text, strictSql] });
        break;
      } catch (error) {
        if (!(error instanceof PostgresContractAcquisitionError) || error.reason !== "context-changed" || attempt >= 2)
          throw error;
      }
    }
    strict.equal(capture.status, "acquired");
    if (capture.status !== "acquired") throw Error("Native project metadata is unavailable");
    const projectCatalog = capture.catalog;
    strict.equal(projectCatalog.entries.length, 2);
    strict.ok(projectCatalog.entries.every((entry) => entry.permission === "fixed-result"));
    const strictDeclaration = projectCatalog.entries
      .map((entry) => entry.definition.routine as RoutineSnapshot)
      .find((routine) => routine.name === "strict_null");
    strict.equal(strictDeclaration?.nullInput, "strict");
    strict.ok(
      strictDeclaration?.result.kind === "scalar" && strictDeclaration.result.nullable,
      "STRICT does not prove a non-null result for non-null arguments",
    );
    strict.equal((await pool.query(strictSql)).rows[0]?.result, null);
    const project = applyProjectCatalogs({
      schema: projectBase,
      context: projectCatalog.context,
      typePolicy: postgres().defaultTypePolicy,
      catalogs: [JSON.parse(JSON.stringify(projectCatalog))],
      contributions: [createPostgresProjectCatalogContribution()],
    });
    const reused = compileSource({
      source: application.replace("::bigint) AS result", "::bigint + 7::bigint) AS result"),
      schema: project.schema,
      dialect: postgres(),
      runtimeMetadata: true,
    });
    strict.deepEqual(
      reused.diagnostics.filter((item) => item.severity === "error"),
      [],
    );
    strict.notEqual(
      reused.queries[0]!.query.sql,
      text,
      "Reusable metadata must support a different SQL statement without a sampled contract",
    );
    strict.match(reused.queries[0]!.rowType, /result.*bigint.*null/u);
    strict.equal(reused.queries[0]!.valuePlan?.columns[0]?.type, "bigint");
    strict.equal(reused.queries[0]!.valuePlan?.parameters[0]?.type, "bigint");
    const catalogDirectory = await mkdtemp(join(directory, ".typed-sql-project-closure-"));
    try {
      const catalogClosure = createProjectCatalogClosure({
        schema: projectBase,
        context: projectCatalog.context,
        typePolicy: profile.defaultTypePolicy,
        catalogs: [projectCatalog],
        contributions: [createPostgresProjectCatalogContribution()],
      });
      const rules = createPostgresContractReconciler({ schema: projectBase });
      const configured = {
        mode: "frozen" as const,
        context: projectCatalog.context,
        identity: postgresContractIdentity(),
        qualification: {
          mode: "hybrid" as const,
          owner: { id: rules.id, version: rules.version },
          requiredNativeFacets: [],
        },
        cache: {
          connectionContext: queryContractDigest("project-catalog-proof"),
          adapter: { id: projectNative.id, version: projectNative.version },
        },
      };
      await exportQueryContracts(
        catalogDirectory,
        [
          createQueryContract({
            sql: reused.queries[0]!.query.sql,
            context: catalogClosure.context,
            origin: "offline-rule",
            valuePlan: reused.queries[0]!.valuePlan!,
          }),
        ],
        {
          selection: {
            scope: createAnalysisContextScope({ profile, schema: projectBase, configuration: configured }),
            context: catalogClosure.context,
            projectCatalogs: catalogClosure,
          },
        },
      );
      const frozenCatalog = await loadFrozenContractView({
        profile,
        schema: projectBase,
        configuration: configured,
        directory: catalogDirectory,
        projectCatalogContributions: [createPostgresProjectCatalogContribution()],
      });
      const frozenReuse = compileSource({
        source: application.replace("::bigint) AS result", "::bigint + 7::bigint) AS result"),
        dialect: frozenCatalog.dialect,
        schema: frozenCatalog.schema,
      });
      strict.deepEqual(
        frozenReuse.diagnostics.filter((item) => item.severity === "error"),
        [],
      );
      strict.match(frozenReuse.queries[0]!.rowType, /result.*bigint.*null/u);
      strict.notEqual(frozenCatalog.context.schemaHash, projectCatalog.context.schemaHash);
      // A selected declaration supports a new query without an exact query contract or native factory.
      await exportQueryContracts(catalogDirectory, [], {
        selection: {
          scope: createAnalysisContextScope({ profile, schema: projectBase, configuration: configured }),
          context: catalogClosure.context,
          projectCatalogs: catalogClosure,
        },
      });
      const catalogSource = application.replace("::bigint) AS result", "::bigint + 7::bigint) AS result");
      await writeFile(join(catalogDirectory, "application.ts"), catalogSource);
      await writeFile(join(catalogDirectory, "schema.json"), JSON.stringify(projectBase));
      await writeFile(join(catalogDirectory, "package.json"), '{"type":"module"}');
      await writeFile(
        join(catalogDirectory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            target: "ESNext",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
          },
          files: ["application.ts"],
        }),
      );
      await writeFile(
        join(catalogDirectory, "typed-sql.config.mjs"),
        `
import {postgresProfile} from "@typed-sql/postgres/profile";
export default {dialect:{...postgresProfile(),async loadAnalyzer(){return (await import("@typed-sql/postgres/analysis")).postgres();}},schema:{file:"schema.json",provider:{introspect(){throw Error("Recorded catalogs must not introspect");}}},outDir:"generated",projects:["tsconfig.json"],analysis:{...${JSON.stringify(configured)},mode:"offline",contractsDir:".",projectCatalogs:{async loadContributions(){return [(await import("@typed-sql/postgres/project-catalog")).createPostgresProjectCatalogContribution()];}},live:{adapter(){throw Error("Recorded catalogs must not acquire native services");}}}};`,
      );
      const cli = join(directory, "packages/cli/dist/packages/cli/src/cli.js");
      const command = (args: string[]) =>
        promisify(callback)(process.execPath, [cli, ...args], { cwd: catalogDirectory, maxBuffer: 8 * 1024 * 1024 });
      strict.match((await command(["check", "--offline", "--show-types"])).stdout, /bigint/u);
      await command(["generate", "--queries", "--offline"]);
      strict.equal((await loadQueryContracts(catalogDirectory)).length, 1);
      strict.match((await command(["check", "--frozen", "--show-types"])).stdout, /bigint/u);
      const editor = new ProtocolClient(
        process.execPath,
        [join(directory, "packages/language-server/dist/packages/language-server/src/server.js"), "--stdio"],
        catalogDirectory,
      );
      try {
        const uri = pathToFileURL(join(catalogDirectory, "application.ts")).href;
        const unsaved = catalogSource.replace("+ 7::bigint", "+ 9::bigint");
        await editor.request("initialize", {
          processId: null,
          rootUri: pathToFileURL(catalogDirectory).href,
          capabilities: { textDocument: { diagnostic: {} } },
          initializationOptions: { nativePreview: false },
        });
        editor.notify("initialized", {});
        editor.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "typescript", version: 1, text: unsaved },
        });
        const diagnostics = (await editor.request("textDocument/diagnostic", { textDocument: { uri } })) as {
          items: { severity?: number }[];
        };
        strict.ok(!diagnostics.items.some((item) => item.severity === 1), JSON.stringify(diagnostics));
        const prefix = unsaved.slice(0, unsaved.indexOf("SELECT")).split("\n");
        const hover = await editor.request("textDocument/hover", {
          textDocument: { uri },
          position: { line: prefix.length - 1, character: prefix.at(-1)!.length },
        });
        strict.match(JSON.stringify(hover), /bigint/u);
      } finally {
        await editor.close();
      }
    } finally {
      await rm(catalogDirectory, { recursive: true, force: true });
    }
    strict.equal(
      (await pool.query<{ count: number }>(`SELECT count FROM ${namespace}.calls`)).rows[0]!.count,
      0,
      "Native catalog selection and offline reuse must not execute the routine",
    );
    const acquired = await acquireNativeQueryContract({
      adapter: native,
      context,
      candidate: { sql: text, parameterOccurrences },
    });
    strict.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") throw Error("Native contract was not acquired");
    strict.equal(
      (await pool.query<{ count: number }>(`SELECT count FROM ${namespace}.calls`)).rows[0]!.count,
      0,
      "Description must not execute the candidate function",
    );
    const inspected = await pool.connect();
    try {
      const connection = (inspected as unknown as { connection: { parsedStatements: Record<string, string> } })
        .connection;
      strict.equal(
        Object.keys(connection.parsedStatements).length,
        0,
        "Acquisition must not grow pg's named-statement SQL cache",
      );
    } finally {
      inspected.release();
    }
    strict.equal(acquired.contract.valuePlan.columns[0]!.type, "bigint");
    strict.equal(acquired.contract.valuePlan.columns[0]!.nullable, true);
    strict.equal(acquired.contract.valuePlan.parameters[0]!.type, "bigint");
    strict.equal(acquired.contract.nativeEvidence!.columns[0]!.nativeType.status, "known");
    strict.equal(acquired.contract.nativeEvidence!.columns[0]!.nullable.status, "unknown");
    temporary = await mkdtemp(join(directory, ".typed-sql-native-contract-"));
    const durable = join(temporary, "contracts");
    const contribution = createPostgresContractReconciler({ schema });
    const qualification = {
      mode: "native-required" as const,
      owner: { id: contribution.id, version: contribution.version },
      requiredNativeFacets: ["runtime-type" as const],
    };
    const staticAnalysis = postgres().analyze(text, schema);
    const reconciled = reconcileQueryContract({
      nativeContract: acquired.contract,
      staticClaim: createStaticQueryClaim({ sql: text, context, analysis: staticAnalysis }),
      contribution,
      policy: qualification,
    });
    strict.equal(reconciled.status, "qualified");
    if (reconciled.status !== "qualified") throw Error("Native/static qualification was incomplete");
    const cacheOptions = {
      directory: join(temporary, ".typed-sql/cache/analysis/v1"),
      workspaceContext: queryContractDigest({ workspace: temporary, config: join(temporary, "typed-sql.config.mjs") }),
    };
    const cache = await openAnalysisCache(cacheOptions);
    const cacheRequest = {
      connectionContext: queryContractDigest("dedicated-native-proof-pool"),
      adapter: { id: native.id, version: native.version },
      candidate: { sql: text, parameterOccurrences },
      staticClaim: createStaticQueryClaim({ sql: text, context, analysis: staticAnalysis }),
      policy: qualification,
    };
    const cacheToken = (await cache.lookup(cacheRequest)).token;
    const live = createLiveAnalysisScheduler({
      debounceMs: 0,
      run: createPersistentLiveAnalysisRunner({
        cache,
        run: createNativeLiveAnalysisRunner({ adapter: native, contribution }),
      }),
    });
    try {
      const state = await new Promise<LiveAnalysisState>((resolve) => {
        live.subscribe(
          {
            ticket: {
              document: "file:///native-contract-proof.ts",
              documentVersion: 1,
              inputGeneration: 0,
              contextGeneration: 0,
              policyGeneration: 0,
            },
            queryId: "increment",
            request: cacheRequest,
          },
          (value) => {
            if (value.kind !== "pending") resolve(value);
          },
        );
      });
      strict.equal(state.kind, "usable-recorded-context");
      if (state.kind !== "usable-recorded-context") throw Error("Live acquisition was incomplete");
      strict.equal(live.view.contracts.length, 1);
      strict.equal(
        (await cache.publish({ token: cacheToken, request: cacheRequest, outcome: state })).status,
        "superseded",
      );
      const reopened = await openAnalysisCache(cacheOptions);
      const cached = await reopened.lookupRecorded({
        candidate: cacheRequest.candidate,
        context,
        connectionContext: cacheRequest.connectionContext,
        adapter: cacheRequest.adapter,
        policy: qualification,
      });
      strict.equal(cached.cached?.freshness, "unverified");
      strict.equal(cached.cached?.outcome.kind, "usable-recorded-context");
      if (cached.cached?.outcome.kind !== "usable-recorded-context") throw Error("Missing cached native contract");
      strict.deepEqual(cached.cached.outcome.contract.valuePlan, reconciled.contract.valuePlan);

      // Terminate a real leased backend after the first context read but before description.
      // Both description and ROLLBACK fail; neither disproves the recorded contract.
      const outagePool = new Pool({ connectionString, max: 1 });
      let leased: PoolClient | undefined;
      let leasedPid: number | undefined;
      const outageAdapter = createPgNativeContractAdapter({
        schema,
        pool: {
          connect: async () => {
            leased = await outagePool.connect();
            leasedPid = (await leased.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0]!.pid;
            return leased;
          },
        },
      });
      try {
        const interrupted = {
          ...outageAdapter,
          async open(signal?: AbortSignal) {
            const session = await outageAdapter.open(signal);
            return {
              ...session,
              async describe(...args: Parameters<typeof session.describe>) {
                if (!leased) throw Error("Missing leased native client");
                const disconnected = once(leased, "error", { signal: AbortSignal.timeout(5000) });
                await pool.query("SELECT pg_catalog.pg_terminate_backend($1)", [leasedPid]);
                await disconnected;
                return session.describe(...args);
              },
            };
          },
        };
        const beforeOutage = await reopened.lookup(cacheRequest);
        const outcome = await createPersistentLiveAnalysisRunner({
          cache: reopened,
          run: createNativeLiveAnalysisRunner({ adapter: interrupted, contribution }),
        })(cacheRequest, new AbortController().signal);
        strict.deepEqual(outcome, { kind: "unavailable", code: "postgres-transport-unavailable", retry: "transport" });
        strict.deepEqual(
          await reopened.lookup(cacheRequest),
          beforeOutage,
          "A real mid-acquisition connection loss must preserve recorded evidence",
        );
      } finally {
        await outagePool.end();
      }

      strict.deepEqual(live.view.contracts[0]!.valuePlan, reconciled.contract.valuePlan);
      strict.equal((await pool.query<{ count: number }>(`SELECT count FROM ${namespace}.calls`)).rows[0]!.count, 0);
      live.advance({ inputGeneration: 0, contextGeneration: 1, policyGeneration: 0 });
      strict.equal(live.view.contracts.length, 0);
    } finally {
      await live.close();
    }
    const wrong = {
      ...staticAnalysis,
      columns: staticAnalysis.columns.map((column) => ({
        ...column,
        tsType: "string",
        runtimeType: "string" as const,
      })),
    };
    const rejected = reconcileQueryContract({
      nativeContract: acquired.contract,
      staticClaim: createStaticQueryClaim({ sql: text, context, analysis: wrong }),
      contribution,
      policy: qualification,
    });
    strict.equal(rejected.status, "conflict");
    strict.ok(!("contract" in rejected));
    const qualificationPolicyHash = queryContractDigest(parseContractQualificationPolicy(qualification));
    strict.equal(reconciled.report.policyHash, qualificationPolicyHash);
    await exportQueryContracts(durable, [reconciled.contract]);
    const dialect = createContractDialect({
      profile,
      context,
      contracts: await loadQueryContracts(durable),
      qualificationPolicyHash,
    });
    const compiled = compileSource({ source: application, schema, dialect, runtimeMetadata: true });
    strict.deepEqual(compiled.diagnostics, []);
    strict.equal(compiled.queries.length, 1);
    strict.match(compiled.queries[0]!.rowType, /result.*bigint.*null/u);
    strict.match(compiled.queries[0]!.parameterType, /bigint.*null/u);
    const file = join(temporary, "queries.mts");
    await writeFile(file, compiled.transformedSource);
    const module = (await import(pathToFileURL(file).href)) as {
      query(value: bigint): Query<{ result: bigint | null }, readonly [bigint]>;
    };
    const database = createPostgresDatabase({ pool: adaptPgPool(pool) });
    strict.deepEqual(await database.all(module.query(41n)), [{ result: 42n }]);
    strict.equal((await pool.query<{ count: number }>(`SELECT count FROM ${namespace}.calls`)).rows[0]!.count, 1);
    // Exercise the product host with the real durable native closure, without allowing analyzer or database provider initialization.
    await writeFile(join(temporary, "schema.json"), JSON.stringify(schema));
    await writeFile(
      join(temporary, "application.ts"),
      application.replace('"@typed-sql/postgres"', '"@typed-sql/postgres/tag"'),
    );
    await writeFile(
      join(temporary, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ESNext",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          allowArbitraryExtensions: true,
        },
        files: ["application.ts"],
      }),
    );
    await writeFile(
      join(temporary, "typed-sql.config.mjs"),
      `
import {defineConfig} from "@typed-sql/core";
import {postgresProfile} from "@typed-sql/postgres/profile";
import {postgresContractIdentity} from "@typed-sql/postgres/contract-profile";
export default defineConfig({
  dialect: {...postgresProfile(), loadAnalyzer(){throw Error("Frozen native proof initialized an analyzer");}},
  schema: {file: "schema.json", provider: {introspect(){throw Error("Frozen native proof opened a provider");}}},
  outDir: "generated", projects: ["tsconfig.json"],
  analysis: {mode: "frozen", context: ${JSON.stringify(context)}, identity: postgresContractIdentity(),
    cache: ${JSON.stringify({ connectionContext: cacheRequest.connectionContext, adapter: cacheRequest.adapter })},
    contractsDir: "contracts", qualification: ${JSON.stringify(qualification)}}
});`,
    );
    // Consume only persisted native evidence: hide durable inputs while checking offline.
    await rename(durable, `${durable}-held`);
    let liveEditor: ProtocolClient | undefined;
    let assertLiveEditorRefresh: (() => Promise<void>) | undefined;
    try {
      const cachedCheck = await promisify(callback)(
        process.execPath,
        [join(directory, "packages/cli/dist/packages/cli/src/cli.js"), "check", "--offline", "--show-types"],
        { cwd: temporary, maxBuffer: 8 * 1024 * 1024 },
      );
      strict.match(cachedCheck.stdout, /Offline checked 1 project\(s\), 1 query\(s\)/u);
      strict.match(cachedCheck.stdout, /bigint/u);
      const editorConfig = await readFile(join(temporary, "typed-sql.config.mjs"), "utf8");
      await writeFile(
        join(temporary, "typed-sql.config.mjs"),
        editorConfig.replace('mode: "frozen"', 'mode: "offline"'),
      );
      const editor = new ProtocolClient(
        process.execPath,
        [join(directory, "packages/language-server/dist/packages/language-server/src/server.js"), "--stdio"],
        temporary,
      );
      try {
        const uri = pathToFileURL(join(temporary, "application.ts")).href;
        const source = await readFile(join(temporary, "application.ts"), "utf8");
        await editor.request("initialize", {
          processId: null,
          rootUri: pathToFileURL(temporary).href,
          capabilities: { textDocument: { diagnostic: {} } },
          initializationOptions: { nativePreview: false },
        });
        editor.notify("initialized", {});
        editor.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "typescript", version: 1, text: source },
        });
        const diagnostics = (await editor.request("textDocument/diagnostic", { textDocument: { uri } })) as {
          items: { message: string; severity?: number }[];
        };
        strict.ok(!diagnostics.items.some((item) => item.severity === 1), JSON.stringify(diagnostics));
        const offset = source.indexOf("SELECT");
        const prefix = source.slice(0, offset).split("\n");
        const hover = await editor.request("textDocument/hover", {
          textDocument: { uri },
          position: { line: prefix.length - 1, character: prefix.at(-1)!.length },
        });
        strict.match(
          JSON.stringify(hover),
          /bigint/u,
          "The built editor host must reuse native cache evidence with durable contracts hidden and factories cold",
        );
      } finally {
        await editor.close();
        await writeFile(join(temporary, "typed-sql.config.mjs"), editorConfig);
      }

      const liveConfig = (await readFile(join(temporary, "typed-sql.config.mjs"), "utf8"))
        .replace(
          'loadAnalyzer(){throw Error("Frozen native proof initialized an analyzer");}',
          'async loadAnalyzer(){if(!process.env.TYPED_SQL_CONTRACT_LIVE_TEST)throw Error("Offline check initialized an analyzer");return (await import("@typed-sql/postgres/analysis")).postgres();}',
        )
        .replace(
          'analysis: {mode: "frozen",',
          `analysis: {mode: "live", live: {adapter: async ({schema}) => {
          if(!process.env.TYPED_SQL_CONTRACT_LIVE_TEST)throw Error("Offline check initialized a native adapter");
          const {Pool}=await import("pg");
          const {createPgNativeContractAdapter}=await import("@typed-sql/postgres/pg-contracts");
          const {createPostgresContractReconciler}=await import("@typed-sql/postgres/reconciliation");
          const pool=new Pool({connectionString:process.env.TYPED_SQL_CONTRACT_TEST_DATABASE_URL,max:2});
          const adapter=createPgNativeContractAdapter({pool,schema});
          return {connectionContext:${JSON.stringify(cacheRequest.connectionContext)},adapter,
            contribution:createPostgresContractReconciler({schema}),inspectContext:signal=>adapter.inspectContext(signal),close:()=>pool.end()};
        }},`,
        );
      const scopedLiveConfig = liveConfig
        .replace("cache: {", 'cache: {"directory":"live-cache",')
        .replace(`context: ${JSON.stringify(context)},`, "");
      await writeFile(join(temporary, "live-config.mjs"), scopedLiveConfig);
      liveEditor = new ProtocolClient(
        process.execPath,
        [join(directory, "packages/language-server/dist/packages/language-server/src/server.js"), "--stdio"],
        temporary,
        {
          ...process.env,
          TYPED_SQL_CONTRACT_LIVE_TEST: "1",
          TYPED_SQL_CONTRACT_TEST_DATABASE_URL: connectionString,
        },
      );
      {
        const client = liveEditor;
        const uri = pathToFileURL(join(temporary, "application.ts")).href;
        const source = await readFile(join(temporary, "application.ts"), "utf8");
        await client.request("initialize", {
          processId: null,
          rootUri: pathToFileURL(temporary).href,
          capabilities: { textDocument: { diagnostic: {} } },
          initializationOptions: { configPath: "live-config.mjs", nativePreview: false },
        });
        client.notify("initialized", {});
        client.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "typescript", version: 1, text: source },
        });
        const diagnostics = (await client.request("textDocument/diagnostic", { textDocument: { uri } })) as {
          items: { message: string; severity?: number }[];
        };
        strict.ok(!diagnostics.items.some((item) => item.severity === 1), JSON.stringify(diagnostics));
        const before = (await client.request("typedSql/status", {})) as {
          workspaces: {
            metrics: { generation: number; analysis?: { observation: string; lastContextCheckAt?: number } };
          }[];
        };
        strict.equal(before.workspaces[0]!.metrics.analysis?.observation, "request-driven");
        strict.equal(typeof before.workspaces[0]!.metrics.analysis?.lastContextCheckAt, "number");
        assertLiveEditorRefresh = async () => {
          await new Promise((resolve) => setTimeout(resolve, 5100));
          // The LSP explicitly asks clients to retry a diagnostic pull whose project snapshot changes.
          const refreshedRequest = async () => {
            for (let attempt = 0; ; attempt++) {
              try {
                return await client.request("textDocument/diagnostic", { textDocument: { uri } });
              } catch (error) {
                if (attempt >= 2 || !(error instanceof Error) || !error.message.includes("-32802")) throw error;
              }
            }
          };
          const refreshed = (await refreshedRequest()) as {
            items: { message: string; severity?: number }[];
          };
          strict.ok(!refreshed.items.some((item) => item.severity === 1), JSON.stringify(refreshed));
          const after = (await client.request("typedSql/status", {})) as typeof before;
          strict.ok(
            after.workspaces[0]!.metrics.generation > before.workspaces[0]!.metrics.generation,
            "A live editor request must observe routine drift and invalidate prior project views",
          );
          strict.equal(
            (await pool.query<{ count: number }>(`SELECT count FROM ${namespace}.calls`)).rows[0]!.count,
            1,
            "Live editor regeneration must describe rather than execute candidate SQL",
          );
        };
      }

      await writeFile(join(temporary, "value.sql"), "SELECT :id::bigint AS asset_value");
      await writeFile(
        join(temporary, "application.ts"),
        `${application.replace('"@typed-sql/postgres"', '"@typed-sql/postgres/tag"')}\nexport const known=sql\`SELECT 1 AS value\`;\nimport asset from "./value.sql"; export const fromAsset=asset({id:1n});`,
      );
      const liveCheck = await promisify(callback)(
        process.execPath,
        [
          join(directory, "packages/cli/dist/packages/cli/src/cli.js"),
          "check",
          "--live",
          "--config",
          "live-config.mjs",
          "--show-types",
        ],
        {
          cwd: temporary,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            TYPED_SQL_CONTRACT_LIVE_TEST: "1",
            TYPED_SQL_CONTRACT_TEST_DATABASE_URL: connectionString,
          },
        },
      );
      strict.match(liveCheck.stdout, /Live checked 1 project\(s\), 3 query\(s\)/u);
      const watchedSourceFile = join(temporary, "application.ts"),
        originalWatchSource = await readFile(watchedSourceFile, "utf8");
      const watchedSource = `${originalWatchSource}\nimport type {QueryRow} from "@typed-sql/core";\ndeclare const watchedRow: QueryRow<ReturnType<typeof query>>;\nexport const expectedWatchResult: bigint | null = watchedRow.result;`;
      await writeFile(watchedSourceFile, watchedSource);
      const watched = startWatchedCli(
        join(directory, "packages/cli/dist/packages/cli/src/cli.js"),
        ["--live", "--config", "live-config.mjs"],
        {
          cwd: temporary,
          env: {
            ...process.env,
            TYPED_SQL_CONTRACT_LIVE_TEST: "1",
            TYPED_SQL_CONTRACT_TEST_DATABASE_URL: connectionString,
          },
        },
      );
      try {
        strict.match(await watched.pass(), /Live checked 1 project\(s\), 3 query\(s\)/u);
        await pool.query(`DROP FUNCTION ${namespace}.increment(bigint)`);
        await pool.query(
          `CREATE FUNCTION ${namespace}.increment(value bigint) RETURNS text LANGUAGE plpgsql AS $$BEGIN UPDATE ${namespace}.calls SET count=count+1; RETURN value::text; END$$`,
        );
        const failed = await watched.pass(() =>
          writeFile(watchedSourceFile, `${watchedSource}\n// Request a fresh native check after database drift.\n`),
        );
        strict.match(failed, /TS2322/u);
        strict.match(failed, /string/u);
        strict.match(failed, /check finished \(1\)/u);
        await pool.query(`DROP FUNCTION ${namespace}.increment(bigint)`);
        await pool.query(
          `CREATE FUNCTION ${namespace}.increment(value bigint) RETURNS bigint LANGUAGE plpgsql AS $$BEGIN UPDATE ${namespace}.calls SET count=count+1; RETURN value+1; END$$`,
        );
        const recovered = await watched.pass(() => writeFile(watchedSourceFile, watchedSource));
        strict.match(recovered, /Live checked 1 project\(s\), 3 query\(s\)/u);
        strict.match(recovered, /check finished \(0\)/u);
      } finally {
        strict.equal(await watched.close(), 143);
        await writeFile(watchedSourceFile, originalWatchSource);
      }
      const reused = await promisify(callback)(
        process.execPath,
        [
          join(directory, "packages/cli/dist/packages/cli/src/cli.js"),
          "check",
          "--offline",
          "--config",
          "live-config.mjs",
          "--show-types",
        ],
        { cwd: temporary, maxBuffer: 8 * 1024 * 1024 },
      );
      strict.match(reused.stdout, /Offline checked 1 project\(s\), 3 query\(s\)/u);
      const generationArgs = [
        join(directory, "packages/cli/dist/packages/cli/src/cli.js"),
        "generate",
        "--queries",
        "--live",
        "--config",
        "live-config.mjs",
        "--out",
        "live-contracts",
      ];
      const generationOptions = {
        cwd: temporary,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          TYPED_SQL_CONTRACT_LIVE_TEST: "1",
          TYPED_SQL_CONTRACT_TEST_DATABASE_URL: connectionString,
        },
      };
      strict.match(
        (await promisify(callback)(process.execPath, generationArgs, generationOptions)).stdout,
        /Generated 3 query contract/u,
      );
      strict.equal((await loadQueryContracts(join(temporary, "live-contracts"))).length, 3);
      const before = await readFile(join(temporary, "live-contracts/manifest.json"), "utf8");
      strict.match(
        (await promisify(callback)(process.execPath, [...generationArgs, "--check"], generationOptions)).stdout,
        /export matches/u,
      );
      strict.equal(await readFile(join(temporary, "live-contracts/manifest.json"), "utf8"), before);
      const firstEpoch = (await loadQueryContracts(join(temporary, "live-contracts")))[0]!.context.databaseContextHash;
      await pool.query(
        `CREATE OR REPLACE FUNCTION ${namespace}.increment(value bigint) RETURNS bigint LANGUAGE plpgsql AS $$BEGIN UPDATE ${namespace}.calls SET count = count + 1; RETURN value + 2; END$$`,
      );
      await assertLiveEditorRefresh();
      await strict.rejects(
        promisify(callback)(process.execPath, [...generationArgs, "--check"], generationOptions),
        (error: unknown) => {
          strict.match((error as { stderr: string }).stderr, /export differs/u);
          return true;
        },
      );
      strict.equal(await readFile(join(temporary, "live-contracts/manifest.json"), "utf8"), before);
      strict.match(
        (await promisify(callback)(process.execPath, generationArgs, generationOptions)).stdout,
        /Generated 3 query contract/u,
      );
      strict.notEqual(
        (await loadQueryContracts(join(temporary, "live-contracts")))[0]!.context.databaseContextHash,
        firstEpoch,
        "Live generation must adopt a changed routine epoch without a pre-recorded context file",
      );
      // Use the same config identity and cache as the successful generation. Only the rule changes.
      await liveEditor.close();
      liveEditor = undefined;
      const qualifiedManifest = await readFile(join(temporary, "live-contracts/manifest.json"), "utf8");
      const qualifiedContext = (await loadQueryContracts(join(temporary, "live-contracts")))[0]!.context;
      const projectCache = await openAnalysisCache({
        directory: join(temporary, "live-cache"),
        workspaceContext: queryContractDigest({ workspace: temporary, config: join(temporary, "live-config.mjs") }),
      });
      const knownQuery = {
        candidate: { sql: "SELECT 1 AS value", parameterOccurrences: [] },
        context: qualifiedContext,
        connectionContext: cacheRequest.connectionContext,
        adapter: cacheRequest.adapter,
        policy: qualification,
      };
      strict.equal((await projectCache.lookupRecorded(knownQuery)).cached?.outcome.kind, "usable-recorded-context");
      const analyzerFactory = '(await import("@typed-sql/postgres/analysis")).postgres()';
      strict.ok(scopedLiveConfig.includes(analyzerFactory));
      const faultyFactory = `await (async () => {
        const analyzer = ${analyzerFactory};
        return {...analyzer, analyze(sql, ...args) {
          const result = analyzer.analyze(sql, ...args);
          if (sql !== "SELECT 1 AS value") return result;
          if (result.diagnostics.length) throw Error("Expected a successful offline claim");
          return {...result, columns: result.columns.map(column => ({
            ...column, tsType: "string", databaseType: "text", runtimeType: "string"
          }))};
        }};
      })()`;
      await writeFile(join(temporary, "live-config.mjs"), scopedLiveConfig.replace(analyzerFactory, faultyFactory));
      try {
        for (const args of [generationArgs, [...generationArgs, "--check"]]) {
          await strict.rejects(promisify(callback)(process.execPath, args, generationOptions), (error: unknown) => {
            strict.equal((error as { code: number }).code, 1);
            strict.match(
              (error as { stderr: string }).stderr,
              /Native-required query generation requires qualified contracts for every candidate/u,
              "A valid existing export cannot hide an incorrect successful offline rule",
            );
            return true;
          });
          strict.equal(
            (await projectCache.lookupRecorded(knownQuery)).cached?.outcome.kind,
            "conflict",
            "Project-wide qualification must persist the native/static conflict in the same cache namespace",
          );
          strict.equal(
            await readFile(join(temporary, "live-contracts/manifest.json"), "utf8"),
            qualifiedManifest,
            "A native/static conflict cannot replace the previously committed durable export",
          );
        }
      } finally {
        await writeFile(join(temporary, "live-config.mjs"), scopedLiveConfig);
      }
      strict.match(
        (await promisify(callback)(process.execPath, [...generationArgs, "--check"], generationOptions)).stdout,
        /export matches/u,
        "Restoring the correct analyzer must recover through fresh native reconciliation",
      );
      strict.equal((await projectCache.lookupRecorded(knownQuery)).cached?.outcome.kind, "usable-recorded-context");
      await writeFile(
        join(temporary, "live-config.mjs"),
        scopedLiveConfig.replace('contractsDir: "contracts"', 'contractsDir: "live-contracts"'),
      );
      await rm(join(temporary, "live-cache"), { recursive: true, force: true });
      const frozenGenerated = await promisify(callback)(
        process.execPath,
        [
          join(directory, "packages/cli/dist/packages/cli/src/cli.js"),
          "check",
          "--frozen",
          "--config",
          "live-config.mjs",
        ],
        { cwd: temporary, maxBuffer: 8 * 1024 * 1024 },
      );
      strict.match(frozenGenerated.stdout, /Frozen checked 1 project\(s\), 3 query\(s\)/u);
      strict.equal(
        (await pool.query<{ count: number }>(`SELECT count FROM ${namespace}.calls`)).rows[0]!.count,
        1,
        "Live CLI qualification must describe rather than execute the candidate function",
      );
    } finally {
      await writeFile(
        join(temporary, "application.ts"),
        application.replace('"@typed-sql/postgres"', '"@typed-sql/postgres/tag"'),
      );
      await liveEditor?.close();
      await rename(`${durable}-held`, durable);
    }
    // Inject real DDL between description and final context inspection. No contract may escape.
    const current = await native.inspectContext();
    const drifting = {
      ...native,
      async open(signal?: AbortSignal) {
        const session = await native.open(signal);
        return {
          ...session,
          async describe(...args: Parameters<typeof session.describe>) {
            const description = await session.describe(...args);
            await pool.query(`COMMENT ON FUNCTION ${namespace}.increment(bigint) IS 'changed during acquisition'`);
            return description;
          },
        };
      },
    };
    await strict.rejects(
      acquireNativeQueryContract({
        adapter: drifting,
        context: current,
        candidate: { sql: text, parameterOccurrences },
      }),
      (error: unknown) => error instanceof PostgresContractAcquisitionError && error.reason === "context-changed",
    );
    const driftingMetadata = {
      ...projectNative,
      async open(signal?: AbortSignal) {
        const session = await projectNative.open(signal);
        return {
          ...session,
          async projectCatalog(...args: Parameters<NonNullable<typeof session.projectCatalog>>) {
            const result = await session.projectCatalog!(...args);
            await pool.query(
              `COMMENT ON FUNCTION ${namespace}.increment(bigint) IS 'changed during metadata acquisition'`,
            );
            return result;
          },
        };
      },
    };
    await strict.rejects(
      acquireNativeProjectCatalog({ adapter: driftingMetadata, sql: [text] }),
      (error: unknown) => error instanceof PostgresContractAcquisitionError && error.reason === "context-changed",
    );
    // A known context change retires disposable evidence, including old in-flight producers.
    await cache.invalidate();
    strict.equal((await cache.lookup(cacheRequest)).cached, undefined);
    strict.equal(
      (
        await cache.publish({
          token: cacheToken,
          request: cacheRequest,
          outcome: { kind: "usable-recorded-context", contract: reconciled.contract },
        })
      ).status,
      "superseded",
    );
    await pool.end();
    // Reopen only durable files and use the synchronous consumer after every native client is closed.
    const offline = compileSource({
      source: application,
      schema,
      dialect: (
        await loadFrozenContractView({
          profile,
          schema,
          directory: durable,
          configuration: {
            mode: "frozen",
            context,
            identity: postgresContractIdentity(),
            qualification,
          },
        })
      ).dialect,
      runtimeMetadata: true,
    });
    strict.deepEqual(offline.diagnostics, []);
    strict.equal(offline.transformedSource, compiled.transformedSource);
    const checked = await promisify(callback)(
      process.execPath,
      [join(directory, "packages/cli/dist/packages/cli/src/cli.js"), "check", "--frozen", "--show-types"],
      { cwd: temporary, maxBuffer: 8 * 1024 * 1024 },
    );
    strict.match(checked.stdout, /Frozen checked 1 project\(s\), 1 query\(s\)/u);
    strict.match(checked.stdout, /bigint/u);
    strict.equal(
      createContractDialect({ profile, context, contracts: [] }).analyze(text, schema).diagnostics[0]?.code,
      "TSQ406",
    );
    await assertIsolatedPostgresContractConsumer({
      contracts: durable,
      context,
      schema,
      source: application,
      expected: compiled.transformedSource,
      qualificationPolicyHash,
      qualification,
    });
    // Cleanup uses a distinct administrative connection, after disconnected reuse has been proved.
    const cleanup = new Pool({ connectionString });
    try {
      strict.equal(
        (await cleanup.query<{ count: number }>(`SELECT count FROM ${namespace}.calls`)).rows[0]!.count,
        1,
        "Packed frozen CLI checks must not execute recorded queries",
      );
      await cleanup.query(`DROP SCHEMA ${namespace} CASCADE`);
      created = false;
    } finally {
      await cleanup.end();
    }
  } finally {
    if (created) {
      const cleanup = new Pool({ connectionString });
      try {
        await cleanup.query(`DROP SCHEMA ${namespace} CASCADE`);
      } finally {
        await cleanup.end();
      }
    }
    if (!pool.ended) await pool.end();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
