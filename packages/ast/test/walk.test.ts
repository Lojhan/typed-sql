import { describe, it, strict } from "poku";
import { parseStatement, walkStatement } from "../src/index.js";

await describe("SQL AST walker", async () => {
  await it("visits nested CTE, relation, expression, and cast syntax once", () => {
    const statement = parseStatement(
      "WITH changed AS (UPDATE accounts SET status = $1 RETURNING id) SELECT CAST(id AS bigint) FROM changed",
    );
    const statements: string[] = [];
    const tables: string[] = [];
    const expressions: string[] = [];
    const types: string[] = [];
    const visibleCtes: string[][] = [];
    walkStatement(statement, {
      statement: (item) => statements.push(item.kind),
      table: (item, _statement, context) => {
        tables.push(item.kind === "table" ? item.name.name : "subquery");
        visibleCtes.push(context.ctes.map(({ name }) => name));
      },
      expression: (item) => expressions.push(item.kind),
      type: (item) => types.push(item.name),
    });
    strict.deepStrictEqual(statements, ["select", "update"]);
    strict.deepStrictEqual(tables, ["accounts", "changed"]);
    strict.deepStrictEqual(visibleCtes, [[], ["changed"]]);
    strict.ok(expressions.includes("parameter"));
    strict.ok(expressions.includes("cast"));
    strict.deepStrictEqual(types, ["bigint"]);
  });

  await it("walks every supported expression and data-changing statement shape", () => {
    const sources = [
      `SELECT ARRAY[$1, 2], ROW(id, $2),
              COUNT(DISTINCT id) FILTER (WHERE active) OVER (PARTITION BY team_id ORDER BY id),
              CAST(id + 1 AS bigint), NOT active,
              CASE id WHEN 1 THEN 2 ELSE 3 END,
              EXISTS (SELECT 1 FROM audit),
              id IN (SELECT user_id FROM audit), id BETWEEN 1 AND 9
       FROM (SELECT id, active, team_id FROM users) AS account
       LEFT JOIN teams ON teams.id = account.team_id
       WHERE account.id > 0 GROUP BY account.id, account.active, account.team_id
       HAVING COUNT(*) > 0 ORDER BY account.id LIMIT 10 OFFSET 1`,
      "INSERT INTO users (id) VALUES ($1), ($2) RETURNING id",
      "INSERT INTO users (id) SELECT id FROM audit RETURNING id",
      "UPDATE users SET id = $1 FROM audit LEFT JOIN teams ON teams.id = audit.team_id WHERE users.id = audit.user_id RETURNING users.id",
      "DELETE FROM users USING audit WHERE users.id = audit.user_id RETURNING users.id",
      "WITH RECURSIVE tree(id) AS (SELECT 1) SELECT id FROM tree",
    ];
    const visited = { statements: 0, tables: 0, expressions: 0, types: 0 };
    for (const source of sources) {
      walkStatement(parseStatement(source), {
        statement: () => {
          visited.statements += 1;
        },
        table: () => {
          visited.tables += 1;
        },
        expression: () => {
          visited.expressions += 1;
        },
        type: () => {
          visited.types += 1;
        },
      });
    }
    strict.ok(visited.statements >= 10);
    strict.ok(visited.tables >= 12);
    strict.ok(visited.expressions >= 60);
    strict.strictEqual(visited.types, 1);
  });
});
