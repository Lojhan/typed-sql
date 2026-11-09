import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { strict } from "poku";
import {
  acquireNativeQueryContract,
  createContractDialect,
  createStaticQueryClaim,
  exportQueryContracts,
  parseContractQualificationPolicy,
  queryContractDigest,
  reconcileQueryContract,
} from "../../packages/analysis/src/index.js";
import { collectSourceQueryCandidates, compileSource } from "../../packages/compiler/src/index.js";
import { applyPlan, createPlan, type MigrationsConfig } from "../../packages/migrations/src/index.js";
import { postgres } from "../../packages/postgres/src/analysis.js";
import { postgresContractReconciliationOwner } from "../../packages/postgres/src/contract-profile.js";
import { createPgMigrationTarget } from "../../packages/postgres/src/migrations.js";
import { pg } from "../../packages/postgres/src/pg.js";
import {
  createPgNativeContractAdapter,
  PostgresContractAcquisitionError,
} from "../../packages/postgres/src/pg-contracts.js";
import { postgresProfile } from "../../packages/postgres/src/profile.js";
import { createPostgresContractReconciler } from "../../packages/postgres/src/reconciliation.js";
import { assertIsolatedPostgresContractConsumer } from "./frozen-contract-consumer.js";

async function observe<Value>(run: () => Promise<Value>): Promise<Value> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof PostgresContractAcquisitionError) || error.reason !== "context-changed" || attempt >= 2)
        throw error;
    }
  }
}
async function closePool(pool: Pool): Promise<void> {
  // pg-pool's end promise can settle before idle clients finish their protocol shutdown.
  // Wait for removal acknowledgements before destroying the owned database.
  let remaining = pool.totalCount;
  let acknowledge: () => void;
  const removed = new Promise<void>((resolve) => {
    acknowledge = resolve;
    if (!remaining) resolve();
  });
  const removal = () => {
    if (--remaining === 0) acknowledge();
  };
  pool.on("remove", removal);
  try {
    await pool.end();
    await removed;
  } finally {
    pool.removeListener("remove", removal);
  }
}

/** Migrations -> native qualification -> durable export -> a separate, network-denied consumer. */
export async function assertMigrationContractConsumer(connectionString: string, workspace: string): Promise<void> {
  const admin = new Pool({ connectionString, max: 1 });
  const names = ["qualification", "replay"].map((kind) => `typed_sql_${kind}_${randomBytes(8).toString("hex")}`);
  const created: string[] = [];
  const pools: Pool[] = [];
  let root: string | undefined;
  try {
    const version = (await admin.query("SELECT current_setting('server_version_num')::int AS version")).rows[0].version;
    // This transport's owner qualifies PostgreSQL 18; other server versions are tested as unavailable.
    if (version < 180000 || version >= 190000) return;
    const url = (database: string) => {
      const value = new URL(connectionString);
      value.pathname = `/${database}`;
      return value.href;
    };
    for (const name of names) {
      await admin.query(`CREATE DATABASE "${name}"`);
      created.push(name);
    }
    root = await mkdtemp(join(workspace, ".typed-sql-migration-contracts-"));
    const migrations = [
      {
        id: "001_accounts",
        up: "CREATE TABLE public.accounts(id bigint NOT NULL PRIMARY KEY); CREATE TABLE public.calls(count integer NOT NULL); INSERT INTO public.calls VALUES (0)",
        down: "DROP TABLE public.calls; DROP TABLE public.accounts",
      },
      {
        id: "002_score",
        up: "CREATE EXTENSION IF NOT EXISTS plpgsql; CREATE FUNCTION public.migrated_score(value bigint) RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$BEGIN UPDATE public.calls SET count=count+1; RETURN value+1; END$$",
        down: "DROP FUNCTION public.migrated_score(bigint)",
      },
    ];
    for (const migration of migrations) {
      const directory = join(root, "migrations", migration.id);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "migration.json"),
        JSON.stringify({ formatVersion: 1, id: migration.id, up: "up.sql", down: "down.sql" }),
      );
      await writeFile(join(directory, "up.sql"), migration.up);
      await writeFile(join(directory, "down.sql"), migration.down);
    }
    const config: MigrationsConfig = {
      directory: "migrations",
      replayTarget: "replay",
      targets: Object.fromEntries(
        names.map((name, index) => [
          index ? "replay" : "qualification",
          createPgMigrationTarget({
            connectionString: url(name),
            expected: { database: name },
            classification: "test",
            ...(index ? { disposable: true } : {}),
          }),
        ]),
      ),
    };
    const options = { root, config, renderer: postgresProfile(), target: "qualification" };
    const plan = await createPlan(options);
    strict.deepEqual(
      (await applyPlan({ ...options, plan })).applied,
      migrations.map(({ id }) => id),
    );
    strict.equal((await createPlan(options)).migrations.length, 0);
    const pool = new Pool({ connectionString: url(names[0]!), max: 1 });
    pools.push(pool);
    // Introspection can retain unqualified extension metadata, but native acquisition must refuse
    // unqualified extension hooks. Do not relax that owner boundary to make this fixture pass.
    // A role named typed_sql can resolve $user to the migration history schema.
    // Install the fixture into the same explicit namespace that introspection selects.
    await pool.query("CREATE EXTENSION pgcrypto WITH SCHEMA public");
    const extensionSchema = await pg({ connectionString: url(names[0]!), schemas: ["public"] }).introspect();
    if (extensionSchema.formatVersion !== 2) throw Error("Expected introspected schema v2");
    strict.equal(extensionSchema.routines.pgp_armor_headers?.[0]?.arguments[0]?.name, undefined);
    strict.ok(extensionSchema.routines.pgp_armor_headers?.length);
    await strict.rejects(
      createPgNativeContractAdapter({ pool, schema: extensionSchema }).inspectContext(),
      /unsupported-context/u,
    );
    await pool.query("DROP EXTENSION pgcrypto");
    let schema = await pg({ connectionString: url(names[0]!), schemas: ["public"] }).introspect();
    const profile = postgresProfile();
    const source =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Application source for the installed compiler proof.
      'import {sql} from "@typed-sql/postgres"; export function query(value:bigint){return sql`SELECT public.migrated_score(${value}::bigint) AS result FROM public.accounts a WHERE a.id=1`;}';
    const collected = collectSourceQueryCandidates({ source, profile, schema });
    strict.equal(collected.complete, true);
    strict.equal(collected.candidates.length, 1);
    const candidate = {
      sql: collected.candidates[0]!.sql,
      parameterOccurrences: collected.candidates[0]!.parameterOccurrences,
    };
    const adapter = createPgNativeContractAdapter({ pool, schema });
    let original = await observe(() => adapter.inspectContext());
    const mismatch = async (selected = adapter) => {
      strict.deepEqual(
        await observe(() => acquireNativeQueryContract({ adapter: selected, candidate, context: original })),
        {
          status: "unavailable",
          reason: "context-mismatch",
        },
      );
      strict.equal(
        (await pool.query("SELECT to_regclass('public.accounts') IS NOT NULL AS present")).rows[0].present,
        true,
      );
    };
    await pool.query("ALTER FUNCTION public.migrated_score(bigint) RENAME TO missing_score");
    await mismatch();
    await strict.rejects(createPlan(options), /drift|differ|changed/iu);
    await pool.query("ALTER FUNCTION public.missing_score(bigint) RENAME TO migrated_score");
    original = await observe(() => adapter.inspectContext());
    await pool.query("DROP EXTENSION plpgsql CASCADE");
    await mismatch();
    await strict.rejects(createPlan(options), /drift|differ|changed/iu);
    await pool.query(migrations[1]!.up);
    original = await observe(() => adapter.inspectContext());
    strict.equal(
      (await observe(() => acquireNativeQueryContract({ adapter, candidate, context: original }))).status,
      "acquired",
    );
    const changedSettings = new Pool({
      connectionString: url(names[0]!),
      options: "-c timezone=Pacific/Honolulu",
      max: 1,
    });
    pools.push(changedSettings);
    await mismatch(createPgNativeContractAdapter({ pool: changedSettings, schema }));
    strict.equal((await createPlan(options)).migrations.length, 0);
    schema = await pg({ connectionString: url(names[0]!), schemas: ["public"] }).introspect();
    const freshAdapter = createPgNativeContractAdapter({ pool, schema });

    const policy = parseContractQualificationPolicy({
      mode: "native-required",
      owner: postgresContractReconciliationOwner,
      requiredNativeFacets: ["runtime-type"],
    });
    const acquired = await observe(async () =>
      acquireNativeQueryContract({
        adapter: freshAdapter,
        candidate,
        context: await freshAdapter.inspectContext(),
      }),
    );
    strict.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") throw Error("Migration-derived acquisition unavailable");
    const context = acquired.contract.context;
    const qualified = reconcileQueryContract({
      nativeContract: acquired.contract,
      staticClaim: createStaticQueryClaim({
        sql: candidate.sql,
        context,
        analysis: postgres().analyze(candidate.sql, schema),
      }),
      contribution: createPostgresContractReconciler({ schema }),
      policy,
    });
    strict.equal(qualified.status, "qualified", JSON.stringify(qualified.report));
    if (qualified.status !== "qualified") throw Error("Migration-derived contract not qualified");
    const compiled = compileSource({
      source,
      schema,
      dialect: createContractDialect({
        profile,
        context,
        contracts: [qualified.contract],
        qualificationPolicyHash: queryContractDigest(policy),
      }),
      runtimeMetadata: true,
    });
    strict.deepEqual(compiled.diagnostics, []);
    strict.equal(
      (await pool.query("SELECT count FROM public.calls")).rows[0].count,
      0,
      "Qualification must not execute migrated application routines",
    );
    const contracts = join(root, "contracts");
    await exportQueryContracts(contracts, [qualified.contract]);
    await Promise.all(pools.map(closePool));
    pools.length = 0;
    // Native databases are gone before the separate consumer receives only durable compiler inputs.
    while (created.length) {
      await admin.query(`DROP DATABASE "${created[0]}" WITH (FORCE)`);
      created.shift();
    }
    await assertIsolatedPostgresContractConsumer({
      contracts,
      context,
      schema,
      source,
      expected: compiled.transformedSource,
      qualificationPolicyHash: queryContractDigest(policy),
      qualification: policy,
    });
  } finally {
    await Promise.all(pools.map(closePool));
    try {
      for (const name of created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
      if (root) await rm(root, { recursive: true, force: true });
    }
  }
}
