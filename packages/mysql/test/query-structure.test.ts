import { describe, it, strict } from "poku";
import { type SchemaSnapshot, upgradeSchemaSnapshotV1 } from "../../schema/src/index.js";
import { mySqlServerEvidence, mysql } from "../src/index.js";
import { parseStatement, SqlParseError } from "../src/parser/index.js";
import { resolveMySqlStatement } from "../src/resolver.js";

const schema = {
  formatVersion: 1,
  dialect: "mysql",
  tables: {
    users: {
      name: "users",
      columns: {
        id: { name: "id", databaseType: "bigint unsigned", tsType: "bigint", nullable: false },
        email: { name: "email", databaseType: "varchar(255)", tsType: "string", nullable: false },
        status: { name: "status", databaseType: "varchar(20)", tsType: "string", nullable: false },
        budget: { name: "budget", databaseType: "decimal(14,2)", tsType: "string", nullable: true },
      },
    },
    projects: {
      name: "projects",
      columns: {
        id: { name: "id", databaseType: "int", tsType: "number", nullable: false },
        owner_id: { name: "owner_id", databaseType: "bigint", tsType: "bigint", nullable: false },
      },
    },
  },
  functions: {},
} as const satisfies SchemaSnapshot;

function withMode(sqlMode: string): SchemaSnapshot {
  return { ...schema, server: mySqlServerEvidence("8.4.12", sqlMode) };
}

await describe("MySQL query structure", async () => {
  await it("models set-operation precedence, parenthesized arms, output types, and arity", () => {
    const statement = parseStatement(`
      SELECT id AS value FROM users
      UNION ALL
      SELECT owner_id AS value FROM projects
      INTERSECT
      SELECT id AS value FROM projects
      ORDER BY value LIMIT ?
    `);
    strict.strictEqual(statement.kind, "select");
    if (statement.kind !== "select") return;
    strict.strictEqual(statement.compounds[0]?.operator, "union");
    strict.strictEqual(statement.compounds[0]?.statement.compounds[0]?.operator, "intersect");
    const result = resolveMySqlStatement(statement, schema);
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(result.columns[0]?.name, "value");
    strict.strictEqual(result.columns[0]?.tsType, "bigint | number");
    strict.deepStrictEqual(result.parameters, [{ index: 1, tsType: "number", nullable: false, databaseType: "int" }]);

    const parenthesized = parseStatement(
      "(SELECT id AS value FROM users LIMIT 1) UNION SELECT owner_id AS value FROM projects ORDER BY value",
    );
    strict.strictEqual(parenthesized.kind === "select" && parenthesized.parenthesized, true);
    strict.deepStrictEqual(resolveMySqlStatement(parenthesized, schema).diagnostics, []);
    strict.deepStrictEqual(
      resolveMySqlStatement(
        parseStatement(
          "SELECT id AS value FROM users UNION DISTINCT SELECT owner_id AS value FROM projects ORDER BY 1",
        ),
        schema,
      ).diagnostics,
      [],
    );
    const values = resolveMySqlStatement(
      parseStatement("VALUES ROW(1, 'first'), ROW(2, NULL) ORDER BY column_0"),
      schema,
    );
    strict.deepStrictEqual(values.diagnostics, []);
    strict.deepStrictEqual(
      values.columns.map(({ name, tsType, nullable }) => ({ name, tsType, nullable })),
      [
        { name: "column_0", tsType: "number", nullable: false },
        { name: "column_1", tsType: "string", nullable: true },
      ],
    );
    const tableQuery = resolveMySqlStatement(parseStatement("TABLE projects ORDER BY id LIMIT 1"), schema);
    strict.deepStrictEqual(tableQuery.diagnostics, []);
    strict.deepStrictEqual(
      tableQuery.columns.map(({ name }) => name),
      ["id", "owner_id"],
    );
    const cteTable = resolveMySqlStatement(parseStatement("WITH one AS (VALUES ROW(1)) TABLE one"), schema);
    strict.deepStrictEqual(cteTable.diagnostics, []);
    strict.strictEqual(cteTable.columns[0]?.name, "column_0");

    const mismatched = resolveMySqlStatement(
      parseStatement("SELECT id FROM users UNION SELECT id, owner_id FROM projects"),
      schema,
    );
    strict.ok(mismatched.diagnostics.some(({ code }) => code === "TSQ214"));
    const invalidOrdering = resolveMySqlStatement(
      parseStatement("SELECT id AS value FROM users UNION SELECT id AS value FROM projects ORDER BY projects.id"),
      schema,
    );
    strict.ok(invalidOrdering.diagnostics.some(({ code }) => code === "TSQ228"));
    const invalidLocking = resolveMySqlStatement(
      parseStatement("SELECT id FROM users UNION SELECT id FROM projects FOR UPDATE"),
      schema,
    );
    strict.ok(invalidLocking.diagnostics.some(({ code }) => code === "TSQ401"));
    const armLocking = resolveMySqlStatement(
      parseStatement("(SELECT id FROM users FOR UPDATE) UNION SELECT owner_id AS id FROM projects"),
      schema,
    );
    strict.deepStrictEqual(armLocking.diagnostics, []);
    strict.strictEqual(mysql().capabilities.setOperations, true);
  });

  await it("infers recursive CTEs and rejects invalid recursive member shapes", () => {
    const recursive = resolveMySqlStatement(
      parseStatement(`
        WITH RECURSIVE ids(id) AS (
          SELECT 1 AS id
          UNION ALL
          SELECT id + 1 AS id FROM ids WHERE id < ?
        )
        SELECT id FROM ids
      `),
      schema,
    );
    strict.deepStrictEqual(recursive.diagnostics, []);
    strict.strictEqual(recursive.columns[0]?.tsType, "number");
    strict.strictEqual(recursive.columns[0]?.nullable, true);
    strict.deepStrictEqual(recursive.parameters, [
      { index: 1, tsType: "number", nullable: false, databaseType: "int" },
    ]);
    strict.strictEqual(mysql().capabilities.recursiveCtes, true);

    const missingKeyword = resolveMySqlStatement(
      parseStatement("WITH ids(id) AS (SELECT 1 AS id UNION ALL SELECT id + 1 AS id FROM ids) SELECT id FROM ids"),
      schema,
    );
    strict.ok(missingKeyword.diagnostics.some(({ code }) => code === "TSQ220"));
    const aggregateMember = resolveMySqlStatement(
      parseStatement(
        "WITH RECURSIVE ids(id) AS (SELECT 1 AS id UNION ALL SELECT COUNT(*) AS id FROM ids) SELECT id FROM ids",
      ),
      schema,
    );
    strict.ok(aggregateMember.diagnostics.some(({ code }) => code === "TSQ221"));
    for (const source of [
      "WITH RECURSIVE ids(id) AS (SELECT id FROM ids) SELECT id FROM ids",
      "WITH RECURSIVE ids(id) AS (SELECT 1 AS id INTERSECT SELECT id FROM ids) SELECT id FROM ids",
      "WITH RECURSIVE ids(id) AS (SELECT 1 AS id UNION ALL SELECT a.id FROM ids a JOIN ids b ON true) SELECT id FROM ids",
      "WITH RECURSIVE ids(id) AS (SELECT 1 AS id UNION ALL SELECT ids.id FROM projects LEFT JOIN ids ON true) SELECT id FROM ids",
      "WITH RECURSIVE ids(id) AS (SELECT 1 AS id UNION ALL SELECT id FROM ids UNION ALL SELECT 2 AS id) SELECT id FROM ids",
    ]) {
      strict.ok(
        resolveMySqlStatement(parseStatement(source), schema).diagnostics.some(({ code }) => code === "TSQ220"),
      );
    }
  });

  await it("resolves named and framed windows and fails closed on MySQL restrictions", () => {
    const result = resolveMySqlStatement(
      parseStatement(`
        SELECT SUM(budget) OVER child AS running
        FROM users
        WINDOW child AS (base ORDER BY id ROWS BETWEEN ? PRECEDING AND CURRENT ROW),
               base AS (PARTITION BY status)
      `),
      schema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(result.columns[0]?.tsType, "string");
    strict.deepStrictEqual(result.parameters, [{ index: 1, tsType: "number", nullable: false, databaseType: "int" }]);

    const unknown = resolveMySqlStatement(parseStatement("SELECT COUNT(*) OVER missing AS total FROM users"), schema);
    strict.ok(unknown.diagnostics.some(({ code }) => code === "TSQ222"));
    const invalidRange = resolveMySqlStatement(
      parseStatement("SELECT SUM(budget) OVER (RANGE 1 PRECEDING) AS total FROM users"),
      schema,
    );
    strict.ok(invalidRange.diagnostics.some(({ code }) => code === "TSQ222"));
    const distinctWindow = resolveMySqlStatement(
      parseStatement("SELECT COUNT(DISTINCT id) OVER () AS total FROM users"),
      schema,
    );
    strict.ok(distinctWindow.diagnostics.some(({ code }) => code === "TSQ223"));
    const ranking = resolveMySqlStatement(
      parseStatement("SELECT ROW_NUMBER() OVER (ORDER BY id) AS position FROM users"),
      schema,
    );
    strict.deepStrictEqual(ranking.diagnostics, []);
    strict.strictEqual(ranking.columns[0]?.tsType, "bigint");
    const missingOver = resolveMySqlStatement(parseStatement("SELECT ROW_NUMBER() AS position FROM users"), schema);
    strict.ok(missingOver.diagnostics.some(({ code }) => code === "TSQ223"));
    const windowFamilies = resolveMySqlStatement(
      parseStatement(`
        SELECT CUME_DIST() OVER () AS distribution,
               LAG(id) OVER (ORDER BY id) AS prior_id,
               FIRST_VALUE(id) OVER (ORDER BY id) AS first_id
        FROM users
      `),
      schema,
    );
    strict.deepStrictEqual(windowFamilies.diagnostics, []);
    strict.strictEqual(windowFamilies.columns[0]?.tsType, "number");
    strict.strictEqual(windowFamilies.columns[1]?.nullable, true);
    const nested = resolveMySqlStatement(
      parseStatement("SELECT SUM(ROW_NUMBER() OVER ()) OVER () AS invalid FROM users"),
      schema,
    );
    strict.ok(nested.diagnostics.some(({ code }) => code === "TSQ223"));
    const scalarOver = resolveMySqlStatement(
      parseStatement("SELECT JSON_EXTRACT('{}', '$') OVER () AS invalid FROM users"),
      schema,
    );
    strict.ok(scalarOver.diagnostics.some(({ code }) => code === "TSQ223"));
    const invalidArity = resolveMySqlStatement(parseStatement("SELECT NTILE() OVER () AS bucket FROM users"), schema);
    strict.ok(invalidArity.diagnostics.some(({ code }) => code === "TSQ227"));
    for (const source of [
      "SELECT SUM(budget) OVER (ROWS UNBOUNDED FOLLOWING) AS total FROM users",
      "SELECT SUM(budget) OVER (ROWS BETWEEN CURRENT ROW AND UNBOUNDED PRECEDING) AS total FROM users",
      "SELECT SUM(budget) OVER (ROWS -1 PRECEDING) AS total FROM users",
    ]) {
      strict.ok(
        resolveMySqlStatement(parseStatement(source), schema).diagnostics.some(({ code }) => code === "TSQ222"),
      );
    }
    for (const source of [
      "SELECT COUNT(*) OVER a AS total FROM users WINDOW a AS (b), b AS (a)",
      "SELECT COUNT(*) OVER a AS total FROM users WINDOW a AS (), a AS ()",
      "SELECT COUNT(*) OVER b AS total FROM users WINDOW a AS (PARTITION BY status), b AS (a PARTITION BY id)",
      "SELECT COUNT(*) OVER b AS total FROM users WINDOW a AS (ORDER BY id), b AS (a ORDER BY status)",
      "SELECT COUNT(*) OVER b AS total FROM users WINDOW a AS (ROWS CURRENT ROW), b AS (a)",
    ]) {
      strict.ok(
        resolveMySqlStatement(parseStatement(source), schema).diagnostics.some(({ code }) => code === "TSQ222"),
      );
    }
    const manyWindows = Array.from({ length: 128 }, (_, index) => `w${index} AS ()`).join(", ");
    strict.ok(
      resolveMySqlStatement(
        parseStatement(`SELECT COUNT(*) OVER w0 AS total FROM users WINDOW ${manyWindows}`),
        schema,
      ).diagnostics.some(({ code }) => code === "TSQ222"),
    );
    strict.throws(
      () => parseStatement("SELECT FIRST_VALUE(id) IGNORE NULLS OVER () AS first_id FROM users"),
      (error: unknown) => error instanceof SqlParseError && error.code === "TSQ401",
    );
    strict.throws(
      () => parseStatement("SELECT SUM(budget) OVER (ORDER BY id GROUPS 1 PRECEDING) AS total FROM users"),
      (error: unknown) => error instanceof SqlParseError && error.code === "TSQ401",
    );
  });

  await it("limits LATERAL scope to valid MySQL derived-table positions", () => {
    const lateral = resolveMySqlStatement(
      parseStatement(`
        SELECT u.id, p.project_id
        FROM users u
        JOIN LATERAL (
          SELECT id AS project_id FROM projects WHERE owner_id = u.id
        ) p ON true
      `),
      schema,
    );
    strict.deepStrictEqual(lateral.diagnostics, []);

    const nonlateral = resolveMySqlStatement(
      parseStatement(`
        SELECT u.id FROM users u
        JOIN (SELECT id FROM projects WHERE owner_id = u.id) p ON true
      `),
      schema,
    );
    strict.ok(nonlateral.diagnostics.some(({ code }) => code === "TSQ103"));
    const rightLateral = resolveMySqlStatement(
      parseStatement(`
        SELECT u.id FROM users u
        RIGHT JOIN LATERAL (SELECT id FROM projects WHERE owner_id = u.id) p ON true
      `),
      schema,
    );
    strict.ok(rightLateral.diagnostics.some(({ code }) => code === "TSQ103"));
    strict.deepStrictEqual(
      resolveMySqlStatement(
        parseStatement("SELECT u.id FROM users u RIGHT JOIN LATERAL (SELECT id FROM projects) p ON true"),
        schema,
      ).diagnostics,
      [],
    );
    strict.throws(
      () => parseStatement("SELECT * FROM LATERAL users"),
      (error: unknown) => error instanceof SqlParseError && error.code === "TSQ401",
    );
  });

  await it("applies WITH ROLLUP and ONLY_FULL_GROUP_BY using structural key evidence", () => {
    const rollup = parseStatement("SELECT status, COUNT(*) AS total FROM users GROUP BY status WITH ROLLUP");
    strict.strictEqual(rollup.kind === "select" && rollup.groupRollup, true);
    const rollupResult = resolveMySqlStatement(rollup, schema);
    strict.deepStrictEqual(rollupResult.diagnostics, []);
    strict.strictEqual(rollupResult.columns[0]?.nullable, true);
    const alternativeRollup = parseStatement("SELECT status, COUNT(*) AS total FROM users GROUP BY ROLLUP (status)");
    strict.strictEqual(alternativeRollup.kind === "select" && alternativeRollup.groupRollup, true);

    const invalid = resolveMySqlStatement(
      parseStatement("SELECT status, email, COUNT(*) AS total FROM users GROUP BY status"),
      withMode("ONLY_FULL_GROUP_BY"),
    );
    strict.ok(invalid.diagnostics.some(({ code }) => code === "TSQ228"));
    strict.ok(
      !resolveMySqlStatement(
        parseStatement("SELECT status, email, COUNT(*) AS total FROM users GROUP BY status"),
        withMode(""),
      ).diagnostics.some(({ code }) => code === "TSQ228"),
    );
    const aliases = resolveMySqlStatement(
      parseStatement(
        "SELECT status AS state, COUNT(*) AS total FROM users GROUP BY state HAVING total > 0 ORDER BY total",
      ),
      withMode("ONLY_FULL_GROUP_BY"),
    );
    strict.deepStrictEqual(aliases.diagnostics, []);
    const singleValues = resolveMySqlStatement(
      parseStatement("SELECT status, email, COUNT(*) AS total FROM users WHERE status = ? AND email = 'x'"),
      withMode("ONLY_FULL_GROUP_BY"),
    );
    strict.ok(!singleValues.diagnostics.some(({ code }) => code === "TSQ228"));
    const groupingFunctions = resolveMySqlStatement(
      parseStatement(
        "SELECT ANY_VALUE(email) AS email, GROUPING(status) AS grouped FROM users GROUP BY status WITH ROLLUP",
      ),
      withMode("ONLY_FULL_GROUP_BY"),
    );
    strict.deepStrictEqual(groupingFunctions.diagnostics, []);

    const upgraded = upgradeSchemaSnapshotV1(schema);
    const users = upgraded.relations.users!;
    const structural = {
      ...upgraded,
      server: mySqlServerEvidence("8.4.12", "ONLY_FULL_GROUP_BY"),
      relations: {
        ...upgraded.relations,
        users: {
          ...users,
          constraints: [
            {
              kind: "primary-key",
              identity: "users_primary",
              columns: ["id"],
              partial: false,
              expressionBased: false,
              nullsDistinct: false,
              deferrable: false,
              initiallyDeferred: false,
            },
          ],
        },
      },
    } as const satisfies SchemaSnapshot;
    const dependent = resolveMySqlStatement(
      parseStatement("SELECT id, email, COUNT(*) AS total FROM users GROUP BY id"),
      structural,
    );
    strict.ok(!dependent.diagnostics.some(({ code }) => code === "TSQ228"));
  });
});
