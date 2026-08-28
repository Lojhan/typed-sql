import { describe, it, strict } from "poku";
import { defaultPostgresTypePolicy, type PostgresSchemaSnapshot, postgres, sql, typePolicy } from "../src/index.js";

const schema = {
  formatVersion: 1,
  dialect: "postgres",
  tables: {
    users: {
      name: "users",
      columns: { id: { name: "id", databaseType: "integer", tsType: "number", nullable: false } },
    },
  },
  functions: {
    "public.user_count()": {
      schema: "public",
      name: "user_count",
      argumentTypes: [],
      databaseReturnType: "bigint",
      returnType: "bigint",
      nullable: false,
      volatility: "stable",
    },
  },
} as const satisfies PostgresSchemaSnapshot;

await describe("PostgreSQL dialect plugin", async () => {
  await it("validates snapshots and delegates analysis", () => {
    const dialect = postgres();
    strict.strictEqual(dialect.id, "postgres");
    strict.strictEqual(dialect.sqlModule, "@typed-sql/postgres");
    strict.strictEqual(dialect.capabilities.returning, true);
    strict.strictEqual(dialect.placeholder(2), "$2");
    strict.strictEqual(dialect.quoteIdentifier('account"status'), '"account""status"');
    strict.strictEqual(dialect.validateSnapshot(schema).dialect, "postgres");
    strict.strictEqual(dialect.analyze("SELECT id FROM users", schema).columns[0]?.tsType, "number");
    strict.strictEqual(dialect.analyze("SELECT", schema).diagnostics[0]?.code, "TSQ001");
    strict.throws(() => dialect.placeholder(0), /start at 1/);
    strict.throws(() => dialect.placeholder(1.5), /start at 1/);
    strict.throws(
      () => dialect.validateSnapshot({ formatVersion: 1, dialect: "mysql", tables: {} }),
      /cannot use a mysql/,
    );
    strict.throws(
      () => dialect.validateSnapshot({ ...schema, dialectVersion: "999" }),
      /cannot use snapshot dialectVersion 999/,
    );
  });

  await it("exposes one application API from the dialect package root", () => {
    strict.strictEqual(sql`SELECT 1`.segments[0]?.kind, "text");
    strict.strictEqual(typePolicy, defaultPostgresTypePolicy);
    strict.strictEqual(postgres({ typePolicy }).defaultTypePolicy, typePolicy);
  });

  await it("emits evidence-backed semantics for reads, writes, CTEs, and parse failures", () => {
    const dialect = postgres();
    const read = dialect.analyze("SELECT id FROM users", schema);
    strict.strictEqual(read.semantics.operation.value, "read");
    strict.strictEqual(read.semantics.volatility.value, "stable");
    strict.deepStrictEqual(read.semantics.cardinality, {
      minimum: 0,
      maximum: "many",
      evidence: read.semantics.cardinality.evidence,
    });
    strict.ok(
      read.semantics.dependencies.some(
        ({ kind, access, name, certainty }) =>
          kind === "relation" && access === "read" && name === "users" && certainty === "resolved",
      ),
    );

    const scalar = dialect.analyze("SELECT 1 AS value", schema);
    strict.deepStrictEqual(
      { minimum: scalar.semantics.cardinality.minimum, maximum: scalar.semantics.cardinality.maximum },
      { minimum: 1, maximum: 1 },
    );
    strict.strictEqual(scalar.semantics.volatility.value, "immutable");

    const write = dialect.analyze("UPDATE users SET id = $1 RETURNING id", schema);
    strict.strictEqual(write.semantics.operation.value, "write");
    strict.strictEqual(write.semantics.volatility.value, "volatile");
    strict.ok(write.semantics.capabilities.includes("returning"));
    strict.ok(write.semantics.dependencies.some(({ kind, access }) => kind === "relation" && access === "write"));

    const cte = dialect.analyze(
      "WITH changed AS (UPDATE users SET id = $1 RETURNING id) SELECT id FROM changed",
      schema,
    );
    strict.strictEqual(cte.semantics.operation.value, "write");
    strict.ok(cte.semantics.capabilities.includes("ctes"));
    strict.ok(!cte.semantics.dependencies.some(({ kind, name }) => kind === "relation" && name === "changed"));

    const invalid = dialect.analyze("SELECT", schema);
    strict.strictEqual(invalid.semantics.operation.value, "unknown");
    strict.strictEqual(invalid.semantics.volatility.value, "unknown");
    const knownFunction = dialect.analyze("SELECT user_count() AS value", schema);
    strict.strictEqual(knownFunction.semantics.volatility.value, "stable");
    strict.ok(
      knownFunction.semantics.dependencies.some(
        ({ kind, name, certainty }) => kind === "function" && name === "user_count" && certainty === "resolved",
      ),
    );
    for (const unsupported of ["SELECT id FROM users FOR UPDATE", "CREATE TABLE audit (id integer)"]) {
      const analysis = dialect.analyze(unsupported, schema);
      strict.ok(analysis.diagnostics.some(({ severity }) => severity === "error"));
      strict.strictEqual(analysis.semantics.operation.value, "unknown");
      strict.strictEqual(analysis.semantics.locking.value, "unknown");
    }
  });

  await it("accepts an explicit default type policy", () => {
    const configured = postgres({
      typePolicy: {
        bigint: "string",
        numeric: "number",
        date: "string",
        json: "string",
        enums: "string",
        unknown: "never",
      },
    });
    strict.strictEqual(configured.defaultTypePolicy.bigint, "string");
  });
});
