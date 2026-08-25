import { performance } from "node:perf_hooks";
import { describe, it, strict } from "poku";
import { parseStatement } from "../../ast/src/index.js";
import type { SchemaSnapshot } from "../../schema/src/index.js";
import { mysql, sql, typePolicy } from "../src/index.js";
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
        status: { name: "status", databaseType: "enum('active','suspended')", tsType: '"active" | "suspended"', nullable: false },
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
    "app.user_count()": { schema: "app", name: "user_count", argumentTypes: [], databaseReturnType: "bigint", returnType: "bigint", nullable: true },
  },
} as const satisfies SchemaSnapshot;

await describe("MySQL dialect", async () => {
  await it("implements the shared plugin contract with MySQL placeholders", () => {
    const dialect = mysql();
    strict.strictEqual(dialect.id, "mysql");
    strict.strictEqual(dialect.sqlModule, "@typed-sql/mysql");
    strict.strictEqual(dialect.placeholder(2), "?");
    strict.throws(() => dialect.placeholder(0), /start at 1/);
    strict.throws(() => dialect.validateSnapshot({ ...schema, dialect: "postgres" }), /cannot use a postgres/);
    const result = dialect.analyze("SELECT `id`, `status` FROM `users` WHERE `id` = ?", schema as typeof schema & { readonly dialect: "mysql" });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(result.columns.map(({ name, tsType }) => ({ name, tsType })), [
      { name: "id", tsType: "bigint" }, { name: "status", tsType: '"active" | "suspended"' },
    ]);
    strict.deepStrictEqual(result.parameters, [
      { index: 1, tsType: "bigint", nullable: false, databaseType: "bigint unsigned" },
    ]);
    strict.strictEqual(dialect.analyze("SELECT", schema as typeof schema & { readonly dialect: "mysql" }).diagnostics[0]?.code, "TSQ001");
  });

  await it("exposes one application API from the dialect package root", () => {
    strict.strictEqual(sql`SELECT 1`.segments[0]?.kind, "text");
    strict.strictEqual(typePolicy, defaultMySqlTypePolicy);
    strict.strictEqual(mysql({ typePolicy }).defaultTypePolicy, typePolicy);
  });

  await it("resolves CTEs, aggregates, JSON, joins, subqueries, windows, and MySQL LIMIT", () => {
    const result = resolveMySqlStatement(parseStatement(`
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
    `, { syntax: "mysql" }), schema);
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ215"));
    strict.strictEqual(result.columns.find((column) => column.name === "id")?.tsType, "bigint");
    strict.strictEqual(result.columns.find((column) => column.name === "plan")?.tsType, "string");
    strict.strictEqual(result.columns.find((column) => column.name === "project_count")?.nullable, true);
    strict.strictEqual(result.columns.find((column) => column.name === "identity")?.tsType, "readonly [bigint, string]");
    strict.strictEqual(result.columns.find((column) => column.name === "users")?.tsType, "bigint");
  });

  await it("models expressions, nullability, stars, aliases, and safe failures", () => {
    const result = resolveMySqlStatement(parseStatement(`
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
    `, { syntax: "mysql" }), schema);
    strict.strictEqual(result.columns.find((column) => column.name === "email")?.nullable, true);
    strict.strictEqual(result.columns.find((column) => column.name === "project_id")?.nullable, false);
    strict.strictEqual(result.columns.find((column) => column.name === "ratio")?.tsType, "string");
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ202"));
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ216"));
    strict.ok(resolveMySqlStatement(parseStatement("SELECT id FROM users u JOIN users other ON true", { syntax: "mysql" }), schema).diagnostics.some((diagnostic) => diagnostic.code === "TSQ102"));
    strict.ok(resolveMySqlStatement(parseStatement("SELECT missing.* FROM users", { syntax: "mysql" }), schema).diagnostics.some((diagnostic) => diagnostic.code === "TSQ103"));
    strict.ok(resolveMySqlStatement(parseStatement("SELECT id, id FROM users", { syntax: "mysql" }), schema).diagnostics.some((diagnostic) => diagnostic.code === "TSQ105"));
  });

  await it("infers command-only DML and rejects non-MySQL syntax safely", () => {
    const insert = resolveMySqlStatement(parseStatement("INSERT INTO users (email, status) VALUES (?, 'active')", { syntax: "mysql" }), schema);
    strict.strictEqual(insert.resultKind, "command");
    strict.deepStrictEqual(insert.columns, []);
    strict.deepStrictEqual(insert.parameters, [
      { index: 1, tsType: "string", nullable: false, databaseType: "varchar(255)" },
    ]);
    strict.ok(resolveMySqlStatement(parseStatement("INSERT INTO users (email) SELECT email, status FROM users", { syntax: "mysql" }), schema).diagnostics.some((diagnostic) => diagnostic.code === "TSQ214"));
    strict.ok(resolveMySqlStatement(parseStatement("UPDATE users SET missing = 1 WHERE id = ? RETURNING id", { syntax: "mysql" }), schema).diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"));
    strict.ok(resolveMySqlStatement(parseStatement("DELETE FROM users USING projects WHERE users.id = projects.owner_id RETURNING users.id", { syntax: "mysql" }), schema).diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"));
    strict.ok(resolveMySqlStatement(parseStatement("SELECT ARRAY[1] AS values_list", { syntax: "mysql" }), schema).diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"));
    strict.ok(resolveMySqlStatement(parseStatement("SELECT DISTINCT ON (id) id FROM users", { syntax: "mysql" }), schema).diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"));
    strict.ok(resolveMySqlStatement(parseStatement("SELECT * FROM users FULL JOIN projects ON users.id = projects.owner_id", { syntax: "mysql" }), schema).diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"));
    strict.ok(resolveMySqlStatement(parseStatement("WITH RECURSIVE ids(id) AS (SELECT 1) SELECT id FROM ids", { syntax: "mysql" }), schema).diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"));
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
    const result = resolveMySqlStatement(parseStatement(`
      SELECT email_label(?) AS label, CAST(? AS DECIMAL) AS casted, ? AS unresolved
      FROM users
      WHERE id = ? AND budget BETWEEN ? AND ? AND status IN (?)
      LIMIT ?
    `, { syntax: "mysql" }), parameterSchema);
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(result.parameters, [
      { index: 1, tsType: "string", nullable: true, databaseType: "varchar" },
      { index: 2, tsType: "string", nullable: true, databaseType: "decimal" },
      { index: 3, tsType: "unknown", nullable: true },
      { index: 4, tsType: "bigint", nullable: false, databaseType: "bigint unsigned" },
      { index: 5, tsType: "string", nullable: true, databaseType: "decimal(14,2)" },
      { index: 6, tsType: "string", nullable: true, databaseType: "decimal(14,2)" },
      { index: 7, tsType: '\"active\" | \"suspended\"', nullable: false, databaseType: "enum('active','suspended')" },
      { index: 8, tsType: "number", nullable: false, databaseType: "int" },
    ]);
  });

  await it("maps the MySQL catalog type families under explicit policies", () => {
    strict.strictEqual(mapMySqlType("tinyint(1)", defaultMySqlTypePolicy), "boolean");
    strict.strictEqual(mapMySqlType("bigint unsigned", defaultMySqlTypePolicy), "bigint");
    strict.strictEqual(mapMySqlType("decimal(14,2)", defaultMySqlTypePolicy), "string");
    strict.strictEqual(mapMySqlType("enum('a','b''s')", defaultMySqlTypePolicy), '"a" | "b\'s"');
    strict.strictEqual(mapMySqlType("blob", defaultMySqlTypePolicy), "Uint8Array");
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
