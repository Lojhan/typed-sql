import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Query } from "@typed-sql/core";
import { Pool } from "pg";
import { strict } from "poku";
import {
  acquireNativeQueryContract,
  createContractDialect,
  createStaticQueryClaim,
  exportQueryContracts,
  loadQueryContracts,
  parseContractQualificationPolicy,
  queryContractDigest,
  reconcileQueryContract,
} from "../../packages/analysis/src/index.js";
import { compileSource } from "../../packages/compiler/src/index.js";
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
    const parameterOccurrences = profile.parameterOccurrences!(text, schema).map(({ index, range }) => ({
      index,
      start: range.start,
      end: range.end,
    }));
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
    await pool.end();
    // Reopen only durable files and use the synchronous consumer after every native client is closed.
    const offline = compileSource({
      source: application,
      schema,
      dialect: createContractDialect({
        profile,
        context,
        contracts: await loadQueryContracts(durable),
        qualificationPolicyHash,
      }),
      runtimeMetadata: true,
    });
    strict.deepEqual(offline.diagnostics, []);
    strict.equal(offline.transformedSource, compiled.transformedSource);
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
