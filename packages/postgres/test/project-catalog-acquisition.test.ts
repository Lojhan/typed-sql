import { acquireNativeProjectCatalog } from "@typed-sql/analysis";
import { upgradeSchemaSnapshotV1 } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { postgresServerEvidence } from "../src/capabilities.js";
import type { PgLiveVerifierClient } from "../src/pg.js";
import { createPgNativeContractAdapter, PostgresContractAcquisitionError } from "../src/pg-contracts.js";
import { POSTGRES_DIALECT_VERSION } from "../src/version.js";

const sql = "SELECT project.lookup($1::bigint)";
const row = {
  schema_name: "project",
  function_name: "lookup",
  argument_types: ["bigint"],
  argument_type_identities: ["pg_catalog.int8"],
  argument_names: ["value"],
  argument_modes: ["i"],
  argument_defaults: 0,
  database_return_type: "bigint",
  return_type_identity: "pg_catalog.int8",
  routine_identity: "pg:42",
  routine_kind: "f",
  volatility: "i",
  set_returning: false,
  strict: true,
};
function fixture(
  options: {
    rows?: readonly unknown[];
    epochs?: readonly string[];
    failure?: unknown;
    version?: string;
    legacy?: boolean;
    schemas?: unknown;
  } = {},
) {
  const calls: { text: string; values?: readonly unknown[] }[] = [];
  let releases = 0,
    reads = 0;
  const epoch = () => options.epochs?.[reads++] ?? "0/100";
  const client = {
    async query(text: unknown, values?: readonly unknown[]) {
      if (typeof text !== "string") throw Error("Candidate preparation must not run");
      calls.push({ text, ...(values ? { values } : {}) });
      const common = {
        version: "18.3",
        recovery: false,
        temporary: "0",
        first_schema: "pg_catalog",
        strings: "on",
        encoding: "UTF8",
      };
      if (text.includes("AS fingerprint"))
        return { rows: [{ ...common, fingerprint: "a".repeat(64), epoch: epoch(), extensions: 0 }] };
      if (text.includes("AS first_schema")) return { rows: [common] };
      if (text.includes("AS epoch")) return { rows: [{ epoch: epoch() }] };
      if (text.includes("current_schemas(true)::text[] AS schemas"))
        return { rows: [{ schemas: options.schemas === undefined ? ["pg_catalog", "public"] : options.schemas }] };
      if (text.includes("AS argument_type_identities")) {
        if (options.failure) throw options.failure;
        return { rows: options.rows ?? [row] };
      }
      return { rows: [] };
    },
    release() {
      releases++;
    },
  } as unknown as PgLiveVerifierClient;
  const legacy = {
    formatVersion: 1,
    dialect: "postgres",
    dialectVersion: POSTGRES_DIALECT_VERSION,
    server: postgresServerEvidence(options.version ?? "18.3"),
    tables: {},
  } as const;
  const schema = options.legacy ? legacy : upgradeSchemaSnapshotV1(legacy);
  const adapter = createPgNativeContractAdapter({
    schema: { ...schema, dialect: "postgres" },
    pool: { connect: async () => client },
  });
  return {
    adapter,
    calls,
    releases: () => releases,
    run: (selection: readonly string[] = [sql]) => acquireNativeProjectCatalog({ adapter, sql: selection }),
  };
}
await describe("PostgreSQL guarded selected routine acquisition", async () => {
  await it("captures qualified metadata on one lease without preparing candidate SQL or deparsing defaults", async () => {
    const test = fixture();
    const result = await test.run();
    strict.equal(result.status, "acquired");
    if (result.status !== "acquired") throw Error("Expected catalog");
    strict.equal(result.catalog.entries.length, 1);
    strict.equal(result.catalog.entries[0]?.permission, "fixed-result");
    const selected = test.calls.filter((call) => call.text.includes("AS argument_type_identities"));
    strict.equal(selected.length, 1);
    strict.deepEqual(selected[0]?.values, [["project"], ["project"], ["lookup"]]);
    strict.match(selected[0]!.text, /LIMIT 4097/u);
    strict.ok(
      test.calls.every(
        (call) => call.text !== sql && !call.text.includes("pg_get_expr") && !call.text.includes("pg_get_functiondef"),
      ),
    );
    strict.equal(test.releases(), 1);
  });
  await it("uses observed search-path namespaces and keeps unsupported/empty selections explicit", async () => {
    const search = fixture({ rows: [{ ...row, schema_name: "public" }] });
    strict.equal((await search.run(["SELECT lookup(1::bigint)"])).status, "acquired");
    strict.deepEqual(search.calls.find((call) => call.text.includes("AS argument_type_identities"))?.values, [
      ["pg_catalog", "public"],
      ["pg_catalog", "public"],
      ["lookup", "lookup"],
    ]);
    const empty = fixture();
    const captured = await empty.run(["SELECT 1"]);
    strict.equal(captured.status, "acquired");
    if (captured.status === "acquired") strict.deepEqual(captured.catalog.entries, []);
    strict.ok(empty.calls.every((call) => !call.text.includes("AS argument_type_identities")));
    const legacy = fixture({ legacy: true });
    strict.deepEqual(await legacy.run(), { status: "unavailable", reason: "unsupported-adapter" });
    strict.deepEqual(legacy.calls, []);
    await strict.rejects(
      fixture().run(["SELECT project.K(1)"]),
      (error: unknown) =>
        error instanceof PostgresContractAcquisitionError && error.reason === "unsupported-catalog-selection",
    );
    await strict.rejects(
      fixture().run(["SELECT project.lookup("]),
      (error: unknown) =>
        error instanceof PostgresContractAcquisitionError && error.reason === "unsupported-catalog-selection",
    );
  });
  await it("does not publish truncated families, stale server evidence or a changed catalog epoch", async () => {
    for (const test of [fixture({ rows: Array(4097).fill(row) }), fixture({ schemas: null })]) {
      await strict.rejects(
        test.run(["SELECT lookup(1)"]),
        (error: unknown) =>
          error instanceof PostgresContractAcquisitionError && error.reason === "metadata-unavailable",
      );
      strict.equal(test.releases(), 1);
    }
    const stale = fixture({ version: "18.2" });
    await strict.rejects(
      stale.run(),
      (error: unknown) => error instanceof PostgresContractAcquisitionError && error.reason === "unsupported-context",
    );
    const drift = fixture({ epochs: ["0/100", "0/100", "0/101"] });
    await strict.rejects(
      drift.run(),
      (error: unknown) => error instanceof PostgresContractAcquisitionError && error.reason === "context-changed",
    );
    strict.equal(drift.releases(), 1);
  });
  await it("sanitizes metadata failures and prevents mixed operations on a leased session", async () => {
    const broken = fixture({ failure: Object.assign(Error("private source details"), { code: "42501" }) });
    await strict.rejects(
      broken.run(),
      (error: unknown) =>
        error instanceof PostgresContractAcquisitionError &&
        error.reason === "metadata-unavailable" &&
        !error.message.includes("private"),
    );
    const session = await fixture().adapter.open();
    try {
      const context = await session.context();
      await session.projectCatalog!([sql], context);
      await strict.rejects(session.projectCatalog!([sql], context), /unsupported-context/u);
      await strict.rejects(session.describe({ sql, parameterOccurrences: [] }), /unsupported-context/u);
    } finally {
      await session.close();
    }
    const invalid = fixture({ failure: Object.assign(Error("private network"), { code: "ECONNRESET" }) });
    await strict.rejects(
      invalid.run(),
      (error: unknown) => error instanceof PostgresContractAcquisitionError && error.reason === "transport-unavailable",
    );
  });
});
