import type { Pool } from "pg";
import { strict } from "poku";
import { acquireNativeQueryContract } from "../../packages/analysis/src/index.js";
import {
  createPgNativeContractAdapter,
  PostgresContractAcquisitionError,
} from "../../packages/postgres/src/pg-contracts.js";
import { defaultPostgresTypePolicy } from "../../packages/postgres/src/type-policy.js";

/** Real PostgreSQL 18 mutations on the caller's disposable, exclusively owned fixture. */
export async function assertPostgresContextMutations(
  pool: Pool,
  schema: Parameters<typeof createPgNativeContractAdapter>[0]["schema"],
  namespace: string,
): Promise<void> {
  strict.match(namespace, /^typed_sql_contract_\d+$/u);
  const role = `${namespace}_context`;
  const adapter = (changes: readonly string[] = [], policy = defaultPostgresTypePolicy) =>
    createPgNativeContractAdapter({
      schema,
      typePolicy: policy,
      pool: {
        async connect() {
          const client = await pool.connect();
          return {
            async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
              const result = await client.query<Row>(sql, values === undefined ? [] : [...values]);
              if (sql === "BEGIN READ ONLY") {
                await client.query("SET LOCAL search_path TO pg_catalog, public");
                await client.query("SET LOCAL TimeZone TO 'UTC'");
                for (const change of changes) await client.query(change);
              }
              return result;
            },
            release: client.release.bind(client),
          };
        },
      },
    });
  const candidate = {
    sql: "SELECT $1::bigint AS value",
    parameterOccurrences: [{ index: 1, start: 7, end: 9 }],
  };
  const rejectsPriorContext = async (
    selected: ReturnType<typeof adapter>,
    before: Awaited<ReturnType<ReturnType<typeof adapter>["inspectContext"]>>,
    message: string,
  ) => {
    for (let attempt = 0; ; attempt++) {
      try {
        strict.deepEqual(
          await acquireNativeQueryContract({ adapter: selected, context: before, candidate }),
          { status: "unavailable", reason: "context-mismatch" },
          message,
        );
        return;
      } catch (error) {
        if (!(error instanceof PostgresContractAcquisitionError) || error.reason !== "context-changed" || attempt >= 2)
          throw error;
      }
    }
  };
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  try {
    const base = adapter();
    const before = await base.inspectContext();
    for (const [name, change] of [
      ["search path", `SET LOCAL search_path TO pg_catalog, ${namespace}, public`],
      ["semantic setting", "SET LOCAL TimeZone TO 'Pacific/Honolulu'"],
      ["authorization principal", `SET LOCAL ROLE ${role}`],
    ] as const) {
      const selected = adapter([change]);
      const after = await selected.inspectContext();
      strict.notEqual(after.databaseContextHash, before.databaseContextHash, `${name} changes native context`);
      strict.equal(after.schemaHash, before.schemaHash, `${name} proof keeps the compiler schema fixed`);
      await rejectsPriorContext(selected, before, `${name} cannot reuse the old context`);
    }
    await pool.query(`GRANT SELECT ON ${namespace}.calls TO ${role}`);
    const granted = await base.inspectContext();
    strict.notEqual(granted.databaseContextHash, before.databaseContextHash, "Permission grants change native context");
    await rejectsPriorContext(
      base,
      before,
      "A permission change cannot reuse the old context even for the same principal",
    );
    const selected = adapter([], { ...defaultPostgresTypePolicy, bigint: "string" });
    const changedPolicy = await selected.inspectContext();
    strict.equal(changedPolicy.databaseContextHash, granted.databaseContextHash);
    strict.notEqual(changedPolicy.typePolicyHash, granted.typePolicyHash, "Decoding policy changes its identity");
    strict.notEqual(changedPolicy.codecHash, granted.codecHash, "Decoding policy changes codec identity");
    await rejectsPriorContext(selected, granted, "A different codec policy cannot reuse the old context");
  } finally {
    await pool.query(`REVOKE ALL ON ${namespace}.calls FROM ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
}
