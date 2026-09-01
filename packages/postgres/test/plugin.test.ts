import { resolveDialectCapabilityStates } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import {
  defaultPostgresTypePolicy,
  POSTGRES_SUPPORT_POLICY,
  type PostgresSchemaSnapshot,
  postgres,
  postgresVersionSupport,
  sql,
  typePolicy,
} from "../src/index.js";

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
  await it("freezes the upstream-supported major, exact minor, canary, and deprecation policy", () => {
    strict.deepStrictEqual(POSTGRES_SUPPORT_POLICY.stableMajors, [14, 15, 16, 17, 18]);
    strict.deepStrictEqual(POSTGRES_SUPPORT_POLICY.matrixMinors, {
      14: "14.24",
      15: "15.19",
      16: "16.15",
      17: "17.11",
      18: "18.6",
    });
    strict.deepStrictEqual(POSTGRES_SUPPORT_POLICY.canary, { major: 19, version: "19beta3" });
    strict.strictEqual(POSTGRES_SUPPORT_POLICY.deprecation.noticeBeforeUpstreamEolDays, 90);
    strict.strictEqual(POSTGRES_SUPPORT_POLICY.deprecation.removal, "first-typed-sql-minor-after-upstream-eol");
    strict.strictEqual(postgresVersionSupport("14.24"), "supported");
    strict.strictEqual(postgresVersionSupport("18.6"), "supported");
    strict.strictEqual(postgresVersionSupport("13.23"), "below-supported");
    strict.strictEqual(postgresVersionSupport("19beta3"), "prerelease");
    strict.strictEqual(postgresVersionSupport("19beta3", "canary"), "canary");
    strict.strictEqual(postgresVersionSupport("20devel", "canary"), "prerelease");
    strict.strictEqual(postgresVersionSupport("20"), "newer-than-tested");
    strict.strictEqual(postgresVersionSupport("development"), "unknown");
    strict.ok(Object.isFrozen(POSTGRES_SUPPORT_POLICY));
    strict.ok(Object.isFrozen(POSTGRES_SUPPORT_POLICY.matrixMinors));
  });

  await it("resolves exact capabilities only inside the tested PostgreSQL support band", () => {
    const dialect = postgres();
    const exact = resolveDialectCapabilityStates(dialect, {
      ...schema,
      version: "18.6",
      server: {
        product: "postgres",
        version: "18.6",
        versionKey: "18",
        features: ["plpgsql:1.0"],
        settings: { standardConformingStrings: "on" },
      },
    });
    strict.strictEqual(exact.returning?.level, "exact");
    strict.ok(exact.returning?.evidence.some(({ kind, key }) => kind === "feature" && key === "plpgsql:1.0"));
    strict.strictEqual(dialect.resolveCapabilities?.(schema).returning?.level, "conservative");
    strict.strictEqual(
      dialect.resolveCapabilities?.({
        ...schema,
        server: {
          product: "postgres",
          version: "13.9",
          versionKey: "13",
          features: [],
          settings: { standardConformingStrings: "on" },
        },
      }).returning?.diagnostic,
      "TSQ403",
    );
    strict.strictEqual(
      dialect.resolveCapabilities?.({
        ...schema,
        server: {
          product: "postgres",
          version: "14.0",
          versionKey: "14",
          features: [],
          settings: { standardConformingStrings: "on" },
        },
      }).returning?.level,
      "exact",
    );
    strict.strictEqual(
      dialect.resolveCapabilities?.({
        ...schema,
        server: {
          product: "postgres",
          version: "18.6",
          versionKey: "18",
          features: [],
          settings: { standardConformingStrings: "off" },
        },
      }).returning?.diagnostic,
      "TSQ407",
    );
    strict.strictEqual(
      dialect.resolveCapabilities?.({ ...schema, version: "19beta1" }).returning?.level,
      "conservative",
    );
    strict.strictEqual(
      postgres({ versionPolicy: "canary" }).resolveCapabilities?.({
        ...schema,
        server: {
          product: "postgres",
          version: "19beta1",
          versionKey: "19",
          features: [],
          settings: { standardConformingStrings: "on" },
        },
      }).returning?.level,
      "exact",
    );
  });

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
    strict.throws(
      () =>
        dialect.validateSnapshot({
          ...schema,
          server: {
            product: "postgres",
            version: "18.6",
            versionKey: "18",
            features: [],
            settings: { applicationName: "unsafe" },
          },
        }),
      /non-allowlisted/u,
    );
    strict.throws(
      () =>
        dialect.validateSnapshot({
          ...schema,
          server: {
            product: "postgres",
            version: "18.6",
            versionKey: "17",
            features: [],
            settings: { standardConformingStrings: "on" },
          },
        }),
      /versionKey must match/u,
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
    const locking = dialect.analyze("SELECT id FROM users FOR UPDATE SKIP LOCKED", schema);
    strict.strictEqual(locking.semantics.operation.value, "read");
    strict.strictEqual(locking.semantics.locking.value, "row");
    strict.strictEqual(locking.semantics.connectionAffinity.value, "transaction");
    strict.ok(locking.semantics.capabilities.includes("lockingReads"));
    const invalidLockingTarget = dialect.analyze("SELECT id FROM users FOR UPDATE OF missing", schema);
    strict.ok(invalidLockingTarget.diagnostics.some(({ code }) => code === "TSQ103"));
    strict.strictEqual(invalidLockingTarget.semantics.operation.value, "unknown");

    for (const unsupported of ["CREATE TABLE audit (id integer)", "SET search_path = public"]) {
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
