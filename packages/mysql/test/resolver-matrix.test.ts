import { describe, it, strict } from "poku";
import { parseStatement } from "../../ast/src/index.js";
import type { SchemaSnapshot } from "../../schema/src/index.js";
import { resolveMySqlStatement } from "../src/resolver.js";

const schema = {
  formatVersion: 1,
  dialect: "mysql",
  tables: {
    users: { schema: "app", name: "users", columns: {
      id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
      email: { name: "email", databaseType: "varchar(255)", tsType: "string", nullable: false },
      budget: { name: "budget", databaseType: "decimal(10,2)", tsType: "string", nullable: true },
      active: { name: "active", databaseType: "tinyint(1)", tsType: "boolean", nullable: false },
      profile: { name: "profile", databaseType: "json", tsType: "unknown", nullable: false },
    } },
    projects: { schema: "app", name: "projects", columns: {
      id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
      owner_id: { name: "owner_id", databaseType: "bigint", tsType: "bigint", nullable: false },
      budget: { name: "budget", databaseType: "decimal(10,2)", tsType: "string", nullable: true },
    } },
  },
  functions: {
    "app.zero()": { schema: "app", name: "zero", argumentTypes: [], databaseReturnType: "int", returnType: "number", nullable: false },
    "app.ambiguous(bigint)": { schema: "app", name: "ambiguous", argumentTypes: ["bigint"], databaseReturnType: "int", returnType: "number", nullable: false },
    "other.ambiguous(bigint)": { schema: "other", name: "ambiguous", argumentTypes: ["bigint"], returnType: "string", nullable: true },
  },
  domains: { money_code: { name: "money_code", databaseType: "varchar", tsType: "MoneyCode", nullable: false } },
} as const satisfies SchemaSnapshot;

const mysqlStatement = (sql: string) => parseStatement(sql, { syntax: "mysql" });
const codes = (sql: string, source: SchemaSnapshot = schema) => resolveMySqlStatement(mysqlStatement(sql), source).diagnostics.map((value) => value.code);

await describe("MySQL resolver safety matrix", async () => {
  await it("covers CTE, relation, and join scope diagnostics", () => {
    strict.ok(codes("WITH x AS (SELECT id FROM users), x AS (SELECT id FROM projects) SELECT id FROM x").includes("TSQ211"));
    strict.ok(codes("WITH x(one, two) AS (SELECT id FROM users) SELECT one FROM x").includes("TSQ213"));
    strict.ok(codes("SELECT * FROM missing").includes("TSQ100"));
    strict.ok(codes("SELECT * FROM users u JOIN projects u ON true").includes("TSQ108"));
    strict.ok(codes("SELECT id FROM users JOIN projects USING (id)").length === 0);
    strict.ok(codes("SELECT * FROM users JOIN projects USING (email)").includes("TSQ215"));
    strict.ok(codes("SELECT users.id AS user_id, projects.id AS project_id FROM users LEFT JOIN projects ON users.id = projects.owner_id").length === 0);
    strict.ok(codes("SELECT users.id AS user_id, projects.id AS project_id FROM users RIGHT JOIN projects ON users.id = projects.owner_id").length === 0);
    strict.ok(codes("SELECT id FROM users CROSS JOIN projects").includes("TSQ102"));
    strict.ok(codes("SELECT *").includes("TSQ103"));

    const duplicate = { ...schema, tables: { ...schema.tables, "audit.users": { ...schema.tables.users, schema: "audit" } } } satisfies SchemaSnapshot;
    strict.ok(codes("SELECT * FROM users", duplicate).includes("TSQ107"));
    strict.deepStrictEqual(codes("SELECT * FROM audit.users", duplicate), []);
  });

  await it("covers command statement arity, lookups, and unsupported RETURNING", () => {
    strict.ok(codes("INSERT INTO users VALUES (1)").includes("TSQ214"));
    strict.ok(codes("INSERT INTO users (email) VALUES ('a', 'b')").includes("TSQ214"));
    strict.ok(codes("INSERT INTO users (missing) VALUES (DEFAULT)").includes("TSQ101"));
    strict.ok(codes("INSERT INTO users (id) SELECT id, owner_id FROM projects").includes("TSQ214"));
    strict.ok(codes("INSERT INTO missing (id) VALUES (1)").includes("TSQ100"));
    strict.ok(codes("UPDATE users SET budget = budget + 1 WHERE active = true").length === 0);
    strict.ok(codes("UPDATE users SET missing = 1").includes("TSQ101"));
    strict.ok(codes("DELETE FROM users USING projects WHERE users.id = projects.owner_id").length === 0);
    strict.ok(codes("INSERT INTO users (id) VALUES (1) RETURNING id").includes("TSQ401"));
  });

  await it("covers expression typing and conservative failure branches", () => {
    const result = resolveMySqlStatement(mysqlStatement(`
      SELECT CAST(NULL AS SIGNED) AS signed_value,
             CAST(id AS money_code) AS domain_value,
             CAST(id AS mystery_type) AS invalid_cast,
             -id AS negative_id,
             email + email AS invalid_math,
             profile->'$.plan' AS json_plan,
             id IS NULL AS id_missing,
             id IN (1, NULL) AS maybe_in,
             id IN (SELECT id, owner_id FROM projects) AS invalid_in,
             CASE WHEN active THEN 'yes' ELSE NULL END AS label,
             (SELECT owner_id FROM projects WHERE projects.owner_id = users.id) AS owner,
             zero(), ambiguous(id), JSON_EXTRACT(profile, '$.plan') AS extracted,
             COUNT(*) OVER (PARTITION BY active ORDER BY id) AS ranked
      FROM users
    `), schema);
    const resultCodes = result.diagnostics.map((value) => value.code);
    strict.ok(resultCodes.includes("TSQ106"));
    strict.ok(resultCodes.includes("TSQ203"));
    strict.ok(resultCodes.includes("TSQ217"));
    strict.ok(resultCodes.includes("TSQ204"));
    strict.strictEqual(result.columns.find((value) => value.name === "domain_value")?.tsType, "MoneyCode");
    strict.strictEqual(result.columns.find((value) => value.name === "owner")?.nullable, true);

    const filter = resolveMySqlStatement(parseStatement("SELECT COUNT(*) FILTER (WHERE active) AS filtered FROM users"), schema);
    strict.ok(filter.diagnostics.some((value) => value.code === "TSQ401"));
    strict.ok(codes("SELECT (SELECT id, owner_id FROM projects) AS bad FROM users").includes("TSQ216"));
    strict.ok(codes("SELECT missing FROM users").includes("TSQ101"));
    strict.ok(codes("SELECT nope.id FROM users").includes("TSQ103"));
  });

  await it("covers output naming, permissive mode, and dialect mismatch", () => {
    strict.ok(codes("SELECT id + 1 FROM users").includes("TSQ104"));
    const permissive = resolveMySqlStatement(mysqlStatement("SELECT id + 1, CAST(id AS SIGNED), COUNT(*), CASE WHEN active THEN 1 END FROM users"), schema, { strictExpressions: false });
    strict.deepStrictEqual(permissive.columns.map((value) => value.name), ["id", "count", "case"]);
    const wrong = resolveMySqlStatement(mysqlStatement("SELECT 1 AS one"), { ...schema, dialect: "postgres" });
    strict.ok(wrong.diagnostics.some((value) => value.code === "TSQ007"));
  });
});
