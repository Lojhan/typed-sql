import type { Pool } from "pg";
import { strict } from "poku";
import {
  acquireNativeQueryContract,
  createContractDialect,
  createStaticQueryClaim,
  parseContractQualificationPolicy,
  queryContractDigest,
  reconcileQueryContract,
} from "../../packages/analysis/src/index.js";
import { compileSource } from "../../packages/compiler/src/index.js";
import { postgres } from "../../packages/postgres/src/analysis.js";
import {
  createPgNativeContractAdapter,
  PostgresContractAcquisitionError,
} from "../../packages/postgres/src/pg-contracts.js";
import { postgresProfile } from "../../packages/postgres/src/profile.js";
import { createPostgresContractReconciler } from "../../packages/postgres/src/reconciliation.js";

/** Real Parse/Describe proof, including planner traps and relation admission before parsing. */
export async function assertPostgresTableContracts(pool: Pool, namespace: string): Promise<void> {
  const before = (await pool.query(`SELECT count FROM ${namespace}.calls`)).rows[0]?.count;
  await pool.query(`
    CREATE TABLE ${namespace}.items (id bigint NOT NULL, label text, amount numeric(12,2));
    INSERT INTO ${namespace}.items VALUES (1, 'one', 12.34);
    CREATE FUNCTION ${namespace}.planner_trap(value bigint) RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS
      $$BEGIN RAISE EXCEPTION 'candidate reached planner'; END$$;
    CREATE VIEW ${namespace}.item_view AS SELECT * FROM ${namespace}.items;
    CREATE TABLE ${namespace}.secured (id bigint);
    ALTER TABLE ${namespace}.secured ENABLE ROW LEVEL SECURITY;
    CREATE DOMAIN ${namespace}.custom_id AS bigint;
    CREATE TABLE ${namespace}.custom_items (id ${namespace}.custom_id);
    CREATE TABLE ${namespace}.array_items (ids bigint[]);
    CREATE TYPE ${namespace}.status_kind AS ENUM ('active', 'inactive');
    CREATE TYPE ${namespace}.record_kind AS (id bigint, label text);
    CREATE TYPE ${namespace}.interval_kind AS RANGE (
      subtype = bigint, multirange_type_name = ${namespace}.interval_set_kind
    );
    CREATE TABLE ${namespace}.enum_items (value ${namespace}.status_kind);
    CREATE TABLE ${namespace}.composite_items (value ${namespace}.record_kind);
    CREATE TABLE ${namespace}.range_items (value ${namespace}.interval_kind);
    CREATE TABLE ${namespace}.multirange_items (value ${namespace}.interval_set_kind);
    CREATE TABLE ${namespace}.generated_items (id bigint, doubled bigint GENERATED ALWAYS AS (id * 2) VIRTUAL);
    CREATE TABLE ${namespace}.parent_items (id bigint);
    CREATE TABLE ${namespace}.child_items () INHERITS (${namespace}.parent_items);
    CREATE TABLE ${namespace}.partition_items (id bigint) PARTITION BY RANGE (id);
    CREATE TABLE ${namespace}.partition_child PARTITION OF ${namespace}.partition_items FOR VALUES FROM (0) TO (10);
    CREATE TABLE ${namespace}."quote""items" (id bigint);
  `);
  const profile = postgresProfile();
  const schema = {
    formatVersion: 1,
    dialect: "postgres",
    tables: {
      [`${namespace}.items`]: {
        schema: namespace,
        name: "items",
        columns: {
          id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
          label: { name: "label", databaseType: "text", tsType: "string", nullable: true },
          amount: { name: "amount", databaseType: "numeric(12,2)", tsType: "string", nullable: true },
        },
      },
    },
  } as const;
  const native = createPgNativeContractAdapter({ pool, schema });
  const acquire = async (sql: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await acquireNativeQueryContract({
          adapter: native,
          context: await native.inspectContext(),
          candidate: {
            sql,
            parameterOccurrences: profile.parameterOccurrences!(sql, schema).map(({ index, range }) => ({
              index,
              start: range.start,
              end: range.end,
            })),
          },
        });
      } catch (error) {
        if (!(error instanceof PostgresContractAcquisitionError) || error.reason !== "context-changed" || attempt >= 2)
          throw error;
      }
    }
  };
  for (const sql of [
    `SELECT ${namespace}.increment(i.id) AS result FROM ${namespace}.items i WHERE i.id = $1::bigint`,
    `SELECT ${namespace}.planner_trap(1::bigint) AS result FROM ${namespace}.items`,
    `SELECT a.id AS result FROM ${namespace}.items a LEFT JOIN ${namespace}.items b ON a.id = b.id WHERE a.id = $1::bigint`,
    `SELECT id AS result FROM ONLY ${namespace}.items`,
    `SELECT id AS result FROM ${namespace}."quote""items"`,
  ]) {
    const result = await acquire(sql);
    strict.equal(result.status, "acquired", sql);
    if (result.status !== "acquired") throw Error("Table contract unavailable");
    strict.equal(result.contract.valuePlan.columns[0]?.type, "bigint");
    strict.equal(result.contract.nativeEvidence?.columns[0]?.nullable.status, "unknown");
    if (sql.includes("$1")) strict.equal(result.contract.valuePlan.parameters[0]?.type, "bigint");
    if (sql.includes("increment")) {
      const context = result.contract.context;
      const contribution = createPostgresContractReconciler({ schema });
      const policy = {
        mode: "native-required" as const,
        owner: { id: contribution.id, version: contribution.version },
        requiredNativeFacets: ["runtime-type" as const],
      };
      const reconciled = reconcileQueryContract({
        nativeContract: result.contract,
        staticClaim: createStaticQueryClaim({ sql, context, analysis: postgres().analyze(sql, schema) }),
        contribution,
        policy,
      });
      strict.equal(reconciled.status, "qualified");
      if (reconciled.status !== "qualified") throw Error("Table contract failed reconciliation");
      const dialect = createContractDialect({
        profile,
        context,
        contracts: [JSON.parse(JSON.stringify(reconciled.contract))],
        qualificationPolicyHash: queryContractDigest(parseContractQualificationPolicy(policy)),
      });
      // This frozen host uses the schema and serialized contract without initializing an analyzer.
      const source =
        'import {sql} from "@typed-sql/postgres"; export function query(value:bigint){return sql`' +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Application source retains the SQL template interpolation.
        sql.replace("$1", "${value}") +
        "`;}";
      const compiled = compileSource({ source, schema, dialect, runtimeMetadata: true });
      strict.deepEqual(compiled.diagnostics, []);
      strict.match(compiled.queries[0]!.rowType, /result.*bigint.*null/u);
      strict.equal(compiled.queries[0]!.valuePlan?.parameters[0]?.type, "bigint");
    }
  }
  const star = await acquire(`SELECT * FROM ${namespace}.items`);
  strict.equal(star.status, "acquired");
  if (star.status !== "acquired") throw Error("Star contract unavailable");
  strict.deepEqual(
    star.contract.nativeEvidence?.columns.map((column) => column.name),
    ["id", "label", "amount"],
  );
  strict.deepEqual(star.contract.nativeEvidence?.columns[2]?.nativeType, {
    status: "known",
    value: { name: "numeric(12,2)", complete: true },
  });
  strict.equal(
    (await pool.query(`SELECT count FROM ${namespace}.calls`)).rows[0]?.count,
    before,
    "Description must not execute candidate routines",
  );
  // Accepted syntax is only a preliminary screen. These server objects must fail admission
  // even when the supplied schema is empty or the current principal bypasses RLS.
  for (const table of [
    "item_view",
    "secured",
    "custom_items",
    "array_items",
    "enum_items",
    "composite_items",
    "range_items",
    "multirange_items",
    "generated_items",
    "parent_items",
    "child_items",
    "partition_items",
    "partition_child",
  ]) {
    await strict.rejects(
      acquire(`SELECT * FROM ${namespace}.${table}`),
      (error: unknown) => error instanceof PostgresContractAcquisitionError && error.reason === "unsupported-context",
      table,
    );
  }
  // The real catalog must establish each class: fixture names alone are not native evidence.
  const customKinds = (
    await pool.query<{ name: string; kind: string }>(
      `SELECT t.typname AS name,t.typtype AS kind FROM pg_catalog.pg_type t
       JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
       WHERE n.nspname=$1 AND t.typname=ANY($2::text[]) ORDER BY t.typname`,
      [namespace, ["custom_id", "status_kind", "record_kind", "interval_kind", "interval_set_kind"]],
    )
  ).rows;
  strict.deepEqual(customKinds, [
    { name: "custom_id", kind: "d" },
    { name: "interval_kind", kind: "r" },
    { name: "interval_set_kind", kind: "m" },
    { name: "record_kind", kind: "c" },
    { name: "status_kind", kind: "e" },
  ]);
  const wrapper = `${namespace}_fdw`;
  await pool.query(`CREATE FOREIGN DATA WRAPPER ${wrapper}; CREATE SERVER ${wrapper} FOREIGN DATA WRAPPER ${wrapper}`);
  try {
    await pool.query(`CREATE FOREIGN TABLE ${namespace}.foreign_items (id bigint) SERVER ${wrapper}`);
    await strict.rejects(
      acquire(`SELECT * FROM ${namespace}.foreign_items`),
      (error: unknown) => error instanceof PostgresContractAcquisitionError && error.reason === "unsupported-context",
    );
  } finally {
    await pool.query(`DROP SERVER ${wrapper} CASCADE; DROP FOREIGN DATA WRAPPER ${wrapper}`);
  }
  // The acquired access-share lock must remain held until the session is closed.
  const session = await native.open();
  const concurrent = await pool.connect();
  try {
    await session.describe({ sql: `SELECT id FROM ${namespace}.items`, parameterOccurrences: [] });
    await concurrent.query("SET lock_timeout = '100ms'");
    await strict.rejects(
      concurrent.query(`ALTER TABLE ${namespace}.items ADD COLUMN blocked integer`),
      (error: unknown) => (error as { code?: string }).code === "55P03",
    );
  } finally {
    await concurrent.query("RESET lock_timeout");
    concurrent.release();
    await session.close();
  }
  await pool.query(`ALTER TABLE ${namespace}.items ADD COLUMN after_close integer`);
}
