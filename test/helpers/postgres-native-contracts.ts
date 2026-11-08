import { execFile as callback } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Query } from "@typed-sql/core";
import { Pool } from "pg";
import { strict } from "poku";
import {
  acquireNativeQueryContract,
  createContractDialect,
  createLiveAnalysisScheduler,
  createNativeLiveAnalysisRunner,
  createPersistentLiveAnalysisRunner,
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
import { postgresContractIdentity } from "../../packages/postgres/src/contract-profile.js";
import { postgres } from "../../packages/postgres/src/index.js";
import { adaptPgPool, type PgLiveVerifierPool } from "../../packages/postgres/src/pg.js";
import {
  createPgNativeContractAdapter,
  PostgresContractAcquisitionError,
} from "../../packages/postgres/src/pg-contracts.js";
import { postgresProfile } from "../../packages/postgres/src/profile.js";
import { createPostgresContractReconciler } from "../../packages/postgres/src/reconciliation.js";
import { createPostgresDatabase } from "../../packages/postgres/src/runtime.js";
import { assertIsolatedPostgresContractConsumer } from "./frozen-contract-consumer.js";

/** Real engine proof: independent description, compiled metadata, actual decoding and offline reuse. */
export async function assertPostgresNativeContracts(connectionString: string, directory: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 2 });
  const schema = { formatVersion: 1, dialect: "postgres", tables: {}, functions: {} } as const;
  const native = createPgNativeContractAdapter({ pool: pool as unknown as PgLiveVerifierPool, schema });
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
    try {
      const cachedCheck = await promisify(callback)(
        process.execPath,
        [join(directory, "packages/cli/dist/packages/cli/src/cli.js"), "check", "--offline", "--show-types"],
        { cwd: temporary, maxBuffer: 8 * 1024 * 1024 },
      );
      strict.match(cachedCheck.stdout, /Offline checked 1 project\(s\), 1 query\(s\)/u);
      strict.match(cachedCheck.stdout, /bigint/u);
    } finally {
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
