import { performance } from "node:perf_hooks";
import { resolveDialectCapabilityStates } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { type SchemaSnapshot, upgradeSchemaSnapshotV1 } from "../../schema/src/index.js";
import {
  mySqlServerEvidence,
  mysql,
  parseMySqlVersion,
  resolveMySqlCapabilities,
  sql,
  typePolicy,
} from "../src/index.js";
import { parseStatement } from "../src/parser/index.js";
import { resolveMySqlStatement } from "../src/resolver.js";
import { defaultMySqlTypePolicy, isKnownMySqlType, mapMySqlType } from "../src/type-policy.js";

const schema = {
  formatVersion: 1,
  dialect: "mysql",
  tables: {
    users: {
      schema: "app",
      name: "users",
      columns: {
        id: { name: "id", databaseType: "bigint unsigned", tsType: "bigint", nullable: false },
        email: { name: "email", databaseType: "varchar(255)", tsType: "string", nullable: false },
        status: {
          name: "status",
          databaseType: "enum('active','suspended')",
          tsType: '"active" | "suspended"',
          nullable: false,
        },
        budget: { name: "budget", databaseType: "decimal(14,2)", tsType: "string", nullable: true },
        active: { name: "active", databaseType: "tinyint(1)", tsType: "boolean", nullable: false },
        profile: { name: "profile", databaseType: "json", tsType: "unknown", nullable: false },
      },
    },
    projects: {
      schema: "app",
      name: "projects",
      columns: {
        id: { name: "id", databaseType: "int", tsType: "number", nullable: false },
        owner_id: { name: "owner_id", databaseType: "bigint", tsType: "bigint", nullable: false },
        budget: { name: "budget", databaseType: "decimal(14,2)", tsType: "string", nullable: true },
      },
    },
  },
  functions: {
    "app.user_count()": {
      schema: "app",
      name: "user_count",
      argumentTypes: [],
      databaseReturnType: "bigint",
      returnType: "bigint",
      nullable: true,
      volatility: "stable",
    },
  },
} as const satisfies SchemaSnapshot;

function serverEvidence(version: string, sqlMode = "") {
  return mySqlServerEvidence(version, {
    versionComment: "MySQL Community Server - GPL",
    sqlMode,
    characterSetServer: "utf8mb4",
    collationServer: "utf8mb4_0900_ai_ci",
    characterSetConnection: "utf8mb4",
    collationConnection: "utf8mb4_0900_ai_ci",
    timeZone: "SYSTEM",
    systemTimeZone: "UTC",
    lowerCaseTableNames: 0,
  });
}

const v2Schema = (() => {
  const upgraded = upgradeSchemaSnapshotV1(schema);
  const users = upgraded.relations.users!;
  return {
    ...upgraded,
    relations: {
      ...upgraded.relations,
      users: {
        ...users,
        columns: {
          ...users.columns,
          id: { ...users.columns.id!, default: "present", identity: "always", insertable: false, updatable: false },
          email: { ...users.columns.email!, default: "none", identity: "none", insertable: true, updatable: true },
          status: { ...users.columns.status!, default: "none", identity: "none", insertable: true, updatable: true },
          profile: { ...users.columns.profile!, default: "none", identity: "none", insertable: true, updatable: false },
        },
      },
    },
  } as const satisfies SchemaSnapshot;
})();

await describe("MySQL dialect", async () => {
  await it("resolves exact capabilities only for tested MySQL LTS lines", () => {
    const dialect = mysql();
    const exact = resolveDialectCapabilityStates(dialect, {
      ...schema,
      version: "8.4.6",
      server: serverEvidence("8.4.6"),
    });
    strict.strictEqual(exact.lockingReads?.level, "exact");
    strict.strictEqual(dialect.resolveCapabilities?.(schema).lockingReads?.level, "conservative");
    strict.strictEqual(
      dialect.resolveCapabilities?.({
        ...schema,
        server: {
          product: "mysql",
          version: "8.3.0",
          versionKey: "8.3.0",
          features: [],
          settings: { sqlMode: "" },
        },
      }).lockingReads?.diagnostic,
      "TSQ403",
    );
    strict.strictEqual(
      dialect.resolveCapabilities?.({
        ...schema,
        server: serverEvidence("9.7.0", "STRICT_TRANS_TABLES"),
      }).lockingReads?.level,
      "exact",
    );
    strict.strictEqual(
      dialect.resolveCapabilities?.({
        ...schema,
        server: serverEvidence("8.4.6-rc1"),
      }).lockingReads?.diagnostic,
      "TSQ403",
    );
    strict.strictEqual(
      dialect.resolveCapabilities?.({
        ...schema,
        server: {
          product: "mysql",
          version: "8.4.6",
          versionKey: "8.4.6",
          features: [],
          settings: {},
        },
      }).lockingReads?.diagnostic,
      "TSQ402",
    );
    strict.strictEqual(
      dialect.resolveCapabilities?.({
        ...schema,
        server: serverEvidence("8.4.6", "ANSI_QUOTES,NO_BACKSLASH_ESCAPES,PIPES_AS_CONCAT"),
      }).lockingReads?.level,
      "exact",
    );
    strict.strictEqual(
      dialect.resolveCapabilities?.({ ...schema, version: "26.7.0" }).lockingReads?.level,
      "conservative",
    );
    strict.strictEqual(
      mysql({ versionPolicy: "canary" }).resolveCapabilities?.({
        ...schema,
        server: serverEvidence("26.7.0", "STRICT_TRANS_TABLES"),
      }).lockingReads?.level,
      "exact",
    );
    strict.strictEqual(
      dialect.resolveCapabilities?.({
        ...schema,
        server: {
          ...serverEvidence("8.4.6"),
          settings: { ...serverEvidence("8.4.6").settings, edition: "unknown" },
        },
      }).lockingReads?.diagnostic,
      "TSQ403",
    );

    strict.strictEqual(parseMySqlVersion("8.4"), undefined);
    strict.throws(() => mySqlServerEvidence("not-a-version"), /Cannot normalize MySQL version/u);
    strict.deepStrictEqual(mySqlServerEvidence("8.4.6-MariaDB", "strict_trans_tables,STRICT_TRANS_TABLES"), {
      product: "mariadb",
      version: "8.4.6-MariaDB",
      versionKey: "8.4.6",
      features: [],
      settings: { sqlMode: "STRICT_TRANS_TABLES" },
    });
    strict.strictEqual(
      resolveMySqlCapabilities({
        ...schema,
        server: {
          product: "mysql",
          version: "not-a-version",
          versionKey: "not-a-version",
          features: [],
          settings: { sqlMode: "" },
        },
      }).lockingReads?.diagnostic,
      "TSQ402",
    );
  });

  await it("implements the shared plugin contract with MySQL placeholders", () => {
    const dialect = mysql();
    strict.strictEqual(dialect.id, "mysql");
    strict.strictEqual(dialect.sqlModule, "@typed-sql/mysql");
    strict.strictEqual(dialect.capabilities.returning, false);
    strict.strictEqual(dialect.placeholder(2), "?");
    strict.strictEqual(dialect.quoteIdentifier("account`status"), "`account``status`");
    strict.throws(() => dialect.placeholder(0), /start at 1/);
    strict.throws(() => dialect.validateSnapshot({ ...schema, dialect: "postgres" }), /cannot use a postgres/);
    strict.throws(() => dialect.validateSnapshot({ ...schema, dialectVersion: "999" }), /dialectVersion 999/);
    strict.throws(
      () =>
        dialect.validateSnapshot({
          ...schema,
          server: {
            product: "mysql",
            version: "8.4.6",
            versionKey: "8.4.6",
            features: [],
            settings: { sqlMode: "STRICT_TRANS_TABLES,ANSI_QUOTES" },
          },
        }),
      /normalized mode list/u,
    );
    const result = dialect.analyze(
      "SELECT `id`, `status` FROM `users` WHERE `id` = ?",
      schema as typeof schema & { readonly dialect: "mysql" },
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, tsType }) => ({ name, tsType })),
      [
        { name: "id", tsType: "bigint" },
        { name: "status", tsType: '"active" | "suspended"' },
      ],
    );
    strict.deepStrictEqual(result.parameters, [
      { index: 1, tsType: "bigint", nullable: false, databaseType: "bigint unsigned" },
    ]);
    const ansiQuoted = dialect.analyze('SELECT "email" FROM users', {
      ...schema,
      server: serverEvidence("8.4.6", "ANSI_QUOTES"),
    } as typeof schema & { readonly dialect: "mysql" });
    strict.deepStrictEqual(ansiQuoted.diagnostics, []);
    strict.deepStrictEqual(
      ansiQuoted.columns.map(({ name, tsType }) => ({ name, tsType })),
      [{ name: "email", tsType: "string" }],
    );
    strict.strictEqual(
      dialect.analyze("SELECT", schema as typeof schema & { readonly dialect: "mysql" }).diagnostics[0]?.code,
      "TSQ001",
    );
  });

  await it("exposes one application API from the dialect package root", () => {
    strict.strictEqual(sql`SELECT 1`.segments[0]?.kind, "text");
    strict.strictEqual(typePolicy, defaultMySqlTypePolicy);
    strict.strictEqual(mysql({ typePolicy }).defaultTypePolicy, typePolicy);
  });

  await it("emits conservative MySQL semantics and stable dependencies", () => {
    const dialect = mysql();
    const typedSchema = schema as typeof schema & { readonly dialect: "mysql" };
    const read = dialect.analyze("SELECT id FROM users", typedSchema);
    strict.strictEqual(read.semantics.operation.value, "read");
    strict.strictEqual(read.semantics.volatility.value, "stable");
    strict.ok(read.semantics.dependencies.some(({ kind, name }) => kind === "relation" && name === "users"));

    const scalar = dialect.analyze("SELECT 1 AS value", typedSchema);
    strict.strictEqual(scalar.semantics.cardinality.minimum, 1);
    strict.strictEqual(scalar.semantics.cardinality.maximum, 1);
    strict.strictEqual(scalar.semantics.volatility.value, "immutable");

    const write = dialect.analyze("UPDATE users SET email = ? WHERE id = ?", typedSchema);
    strict.strictEqual(write.semantics.operation.value, "write");
    strict.strictEqual(write.semantics.volatility.value, "volatile");
    strict.ok(write.semantics.dependencies.some(({ kind, access }) => kind === "relation" && access === "write"));

    const volatile = dialect.analyze("SELECT UUID() AS value", typedSchema);
    strict.strictEqual(volatile.semantics.volatility.value, "volatile");
    const unresolved = dialect.analyze("SELECT not_catalogued() AS value", typedSchema);
    strict.strictEqual(unresolved.semantics.volatility.value, "unknown");
    strict.strictEqual(
      dialect.analyze("SELECT user_count() AS value", typedSchema).semantics.volatility.value,
      "stable",
    );
    strict.strictEqual(dialect.analyze("SELECT", typedSchema).semantics.operation.value, "unknown");
    const locking = dialect.analyze("SELECT id FROM users FOR SHARE NOWAIT", typedSchema);
    strict.strictEqual(locking.semantics.operation.value, "read");
    strict.strictEqual(locking.semantics.locking.value, "row");
    strict.strictEqual(locking.semantics.connectionAffinity.value, "transaction");
    strict.ok(locking.semantics.capabilities.includes("lockingReads"));
    strict.strictEqual(
      dialect.analyze("SELECT id FROM users LOCK IN SHARE MODE", typedSchema).semantics.locking.value,
      "row",
    );
    const multipleLocking = dialect.analyze(
      "SELECT u.id FROM users u JOIN projects p ON p.owner_id = u.id FOR SHARE OF u FOR UPDATE OF p",
      typedSchema,
    );
    strict.deepStrictEqual(multipleLocking.diagnostics, []);
    strict.strictEqual(multipleLocking.semantics.locking.value, "row");
    for (const [source, code] of [
      ["SELECT id FROM users FOR UPDATE OF missing", "TSQ103"],
      ["SELECT u.id FROM users u JOIN projects p ON p.owner_id = u.id FOR UPDATE FOR SHARE OF p", "TSQ401"],
      ["SELECT id FROM users u FOR UPDATE OF u FOR SHARE OF u", "TSQ401"],
    ] as const) {
      const invalidLocking = dialect.analyze(source, typedSchema);
      strict.ok(invalidLocking.diagnostics.some((diagnostic) => diagnostic.code === code));
      strict.strictEqual(invalidLocking.semantics.operation.value, "unknown");
    }

    for (const unsupported of [
      "CREATE TABLE audit (id bigint)",
      "SET @tenant_id = 1",
      "WITH RECURSIVE tree(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM tree) SEARCH DEPTH FIRST BY id SET traversal SELECT id FROM tree",
    ]) {
      const analysis = dialect.analyze(unsupported, typedSchema);
      strict.ok(analysis.diagnostics.some(({ severity }) => severity === "error"));
      strict.strictEqual(analysis.semantics.operation.value, "unknown");
      strict.strictEqual(analysis.semantics.locking.value, "unknown");
    }
    for (const postgresFromSyntax of [
      "SELECT * FROM generate_series(1, 2)",
      "SELECT * FROM ROWS FROM (generate_series(1, 2)) AS values(value)",
      "SELECT id FROM users TABLESAMPLE SYSTEM(10)",
    ]) {
      strict.strictEqual(dialect.analyze(postgresFromSyntax, typedSchema).diagnostics[0]?.code, "TSQ001");
    }
  });

  await it("resolves CTEs, aggregates, JSON, joins, subqueries, windows, and MySQL LIMIT", () => {
    const result = resolveMySqlStatement(
      parseStatement(
        `
      WITH totals AS (
        SELECT owner_id, COUNT(*) AS project_count, SUM(budget) AS total_budget
        FROM projects GROUP BY owner_id
      )
      SELECT u.id, u.status, u.profile->>'$.plan' AS plan,
             totals.project_count, totals.total_budget,
             ROW(u.id, u.email) AS identity,
             user_count() AS users
      FROM app.users AS u
      LEFT JOIN totals USING (id)
      WHERE u.id IN (SELECT owner_id FROM projects) AND EXISTS (SELECT 1 AS one FROM projects)
      WINDOW recent AS (PARTITION BY u.status ORDER BY u.id DESC)
      ORDER BY u.id LIMIT 5, 10
    `,
        { syntax: "mysql" },
      ),
      schema,
    );
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ215"));
    strict.strictEqual(result.columns.find((column) => column.name === "id")?.tsType, "bigint");
    strict.strictEqual(result.columns.find((column) => column.name === "plan")?.tsType, "string");
    strict.strictEqual(result.columns.find((column) => column.name === "project_count")?.nullable, true);
    strict.strictEqual(
      result.columns.find((column) => column.name === "identity")?.tsType,
      "readonly [bigint, string]",
    );
    strict.strictEqual(result.columns.find((column) => column.name === "users")?.tsType, "bigint");
  });

  await it("models expressions, nullability, stars, aliases, and safe failures", () => {
    const result = resolveMySqlStatement(
      parseStatement(
        `
      SELECT u.*, p.id AS project_id,
             NULL AS missing, true AS yes, 1.5 AS decimal_value, ? AS input,
             NOT u.active AS inactive, u.id + 1 AS next_id, u.budget / 2 AS ratio,
             u.budget IS NULL AS budget_missing, u.budget BETWEEN 1 AND NULL AS maybe_range,
             CASE u.status WHEN 'active' THEN u.email END AS selected_email,
             COALESCE(NULL, u.email) AS fallback, IFNULL(u.email, 'x') AS ifnull_value,
             NULLIF(u.email, 'x') AS nullif_value, MIN(u.budget) AS minimum, MAX(u.budget) AS maximum,
             AVG(u.budget) AS average, GROUP_CONCAT(u.email) AS emails,
             JSON_ARRAYAGG(u.profile) AS profiles, mystery(u.id) AS mystery_value,
             (SELECT id, owner_id FROM projects) AS invalid_scalar
      FROM users u RIGHT JOIN projects p ON p.owner_id = u.id
    `,
        { syntax: "mysql" },
      ),
      schema,
    );
    strict.strictEqual(result.columns.find((column) => column.name === "email")?.nullable, true);
    strict.strictEqual(result.columns.find((column) => column.name === "project_id")?.nullable, false);
    strict.strictEqual(result.columns.find((column) => column.name === "ratio")?.tsType, "string");
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ202"));
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ216"));
    strict.ok(
      resolveMySqlStatement(
        parseStatement("SELECT id FROM users u JOIN users other ON true", { syntax: "mysql" }),
        schema,
      ).diagnostics.some((diagnostic) => diagnostic.code === "TSQ102"),
    );
    strict.ok(
      resolveMySqlStatement(
        parseStatement("SELECT missing.* FROM users", { syntax: "mysql" }),
        schema,
      ).diagnostics.some((diagnostic) => diagnostic.code === "TSQ103"),
    );
    strict.ok(
      resolveMySqlStatement(parseStatement("SELECT id, id FROM users", { syntax: "mysql" }), schema).diagnostics.some(
        (diagnostic) => diagnostic.code === "TSQ105",
      ),
    );
  });

  await it("infers command-only DML and rejects non-MySQL syntax safely", () => {
    const insert = resolveMySqlStatement(
      parseStatement("INSERT INTO users (email, status) VALUES (?, 'active')", { syntax: "mysql" }),
      schema,
    );
    strict.strictEqual(insert.resultKind, "command");
    strict.deepStrictEqual(insert.columns, []);
    strict.deepStrictEqual(insert.parameters, [
      { index: 1, tsType: "string", nullable: false, databaseType: "varchar(255)" },
    ]);
    strict.ok(
      resolveMySqlStatement(
        parseStatement("INSERT INTO users (email) SELECT email, status FROM users", { syntax: "mysql" }),
        schema,
      ).diagnostics.some((diagnostic) => diagnostic.code === "TSQ214"),
    );
    for (const source of [
      "INSERT INTO users DEFAULT VALUES",
      "UPDATE users SET email = 'x' FROM projects WHERE users.id = projects.owner_id",
    ]) {
      strict.ok(
        resolveMySqlStatement(parseStatement(source, { syntax: "mysql" }), schema).diagnostics.some(
          (diagnostic) => diagnostic.code === "TSQ401",
        ),
      );
    }
    strict.ok(
      resolveMySqlStatement(
        parseStatement("UPDATE users SET missing = 1 WHERE id = ? RETURNING id", { syntax: "mysql" }),
        schema,
      ).diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"),
    );
    strict.ok(
      resolveMySqlStatement(
        parseStatement("DELETE FROM users USING projects WHERE users.id = projects.owner_id RETURNING users.id", {
          syntax: "mysql",
        }),
        schema,
      ).diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"),
    );
    strict.ok(
      resolveMySqlStatement(
        parseStatement("SELECT ARRAY[1] AS values_list", { syntax: "mysql" }),
        schema,
      ).diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"),
    );
    strict.ok(
      resolveMySqlStatement(
        parseStatement("SELECT DISTINCT ON (id) id FROM users", { syntax: "mysql" }),
        schema,
      ).diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"),
    );
    strict.ok(
      resolveMySqlStatement(
        parseStatement("SELECT * FROM users FULL JOIN projects ON users.id = projects.owner_id", { syntax: "mysql" }),
        schema,
      ).diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"),
    );
  });

  await it("uses v2 write eligibility and required-column evidence without changing v1 behavior", () => {
    const invalidInsert = resolveMySqlStatement(
      parseStatement("INSERT INTO users (id) VALUES (1)", { syntax: "mysql" }),
      v2Schema,
    );
    strict.ok(invalidInsert.diagnostics.some(({ code }) => code === "TSQ218"));
    strict.ok(invalidInsert.diagnostics.some(({ code }) => code === "TSQ219"));
    const invalidUpdate = resolveMySqlStatement(
      parseStatement("UPDATE users SET profile = '{}'", { syntax: "mysql" }),
      v2Schema,
    );
    strict.ok(invalidUpdate.diagnostics.some(({ code }) => code === "TSQ218"));
    strict.deepStrictEqual(
      resolveMySqlStatement(parseStatement("INSERT INTO users (id) VALUES (1)", { syntax: "mysql" }), schema)
        .diagnostics,
      [],
    );
  });

  await it("infers ordered parameters from comparisons, ranges, casts, and function signatures", () => {
    const parameterSchema = {
      ...schema,
      functions: {
        ...schema.functions,
        "app.email_label(varchar)": {
          schema: "app",
          name: "email_label",
          argumentTypes: ["varchar"],
          databaseReturnType: "varchar",
          returnType: "string",
          nullable: false,
        },
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveMySqlStatement(
      parseStatement(
        `
      SELECT email_label(?) AS label, CAST(? AS DECIMAL) AS casted, ? AS unresolved
      FROM users
      WHERE id = ? AND budget BETWEEN ? AND ? AND status IN (?)
      LIMIT ?
    `,
        { syntax: "mysql" },
      ),
      parameterSchema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(result.parameters, [
      { index: 1, tsType: "string", nullable: true, databaseType: "varchar" },
      { index: 2, tsType: "string", nullable: true, databaseType: "decimal" },
      { index: 3, tsType: "unknown", nullable: true },
      { index: 4, tsType: "bigint", nullable: false, databaseType: "bigint unsigned" },
      { index: 5, tsType: "string", nullable: true, databaseType: "decimal(14,2)" },
      { index: 6, tsType: "string", nullable: true, databaseType: "decimal(14,2)" },
      { index: 7, tsType: '"active" | "suspended"', nullable: false, databaseType: "enum('active','suspended')" },
      { index: 8, tsType: "number", nullable: false, databaseType: "int" },
    ]);
  });

  await it("maps the MySQL catalog type families under explicit policies", () => {
    strict.strictEqual(mapMySqlType("tinyint(1)", defaultMySqlTypePolicy), "boolean");
    strict.strictEqual(mapMySqlType("bigint unsigned", defaultMySqlTypePolicy), "bigint");
    strict.strictEqual(mapMySqlType("decimal(14,2)", defaultMySqlTypePolicy), "string");
    strict.strictEqual(mapMySqlType("enum('a','b''s')", defaultMySqlTypePolicy), '"a" | "b\'s"');
    strict.strictEqual(mapMySqlType("blob", defaultMySqlTypePolicy), "Uint8Array");
    strict.strictEqual(mapMySqlType("bit(8)", defaultMySqlTypePolicy), "Uint8Array");
    strict.strictEqual(mapMySqlType("datetime", defaultMySqlTypePolicy), "Date");
    strict.strictEqual(mapMySqlType("json", defaultMySqlTypePolicy), "unknown");
    strict.strictEqual(mapMySqlType("mystery", defaultMySqlTypePolicy), "unknown");
    strict.strictEqual(isKnownMySqlType("varchar(100)"), true);
    strict.strictEqual(isKnownMySqlType("mystery"), false);
  });

  await it("parses escaped enums and hostile catalog types in linear time", () => {
    strict.strictEqual(
      mapMySqlType(String.raw`enum('back\\slash','quote\'d','double''quote')`, defaultMySqlTypePolicy),
      '"back\\\\slash" | "quote\'d" | "double\'quote"',
    );
    const malformedEnum = `enum('${"\\\\".repeat(100_000)}missing-close)`;
    const spacedType = `bigint${" ".repeat(100_000)}signed`;
    const budget = Number(process.env.TYPED_SQL_MYSQL_TYPE_SECURITY_BUDGET_MS ?? "1000");
    const start = performance.now();
    strict.strictEqual(mapMySqlType(malformedEnum, defaultMySqlTypePolicy), "unknown");
    strict.strictEqual(mapMySqlType(spacedType, defaultMySqlTypePolicy), "unknown");
    const duration = performance.now() - start;
    strict.ok(duration <= budget, `MySQL type parsing took ${duration.toFixed(1)}ms; budget is ${budget}ms`);
  });
});
