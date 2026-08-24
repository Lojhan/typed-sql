import { describe, it, strict } from "poku";
import { parseSelect, tokenize } from "../packages/ast/src/index.js";

await describe("PostgreSQL parser", async () => {
  await it("tokenizes comments, quoted identifiers, and source ranges", async () => {
    const tokens = tokenize('-- lead\nSELECT "User".id');
    strict.strictEqual(tokens[0]?.value, "SELECT");
    strict.deepStrictEqual(tokens[0]?.range, { start: 8, end: 14, line: 2, column: 1 });
    strict.strictEqual(tokens[1]?.kind, "quoted-identifier");
    strict.strictEqual(tokens[1]?.value, "User");
  });

  await it("parses aliases, a left join, PostgreSQL casts, and clauses", async () => {
    const statement = parseSelect(`
      SELECT u.id, CAST(u.age AS BIGINT) AS cast_age, u.age::BIGINT AS age
      FROM users AS u
      LEFT JOIN ages a ON u.id = a.user_id
      WHERE u.id = $1
      ORDER BY u.id DESC LIMIT 10
    `);
    strict.strictEqual(statement.columns.length, 3);
    strict.strictEqual(statement.columns[1]?.expression.kind, "cast");
    strict.strictEqual(statement.columns[2]?.expression.kind, "cast");
    strict.strictEqual(statement.joins[0]?.kind, "left");
    strict.strictEqual(statement.where?.kind, "binary");
    strict.strictEqual(statement.orderBy[0]?.direction, "desc");
    strict.strictEqual(statement.limit?.kind, "literal");
  });

  await it("parses CASE, COALESCE, and aggregates", async () => {
    const statement = parseSelect(`
      SELECT CASE WHEN age IS NULL THEN 0 ELSE age END AS safe_age,
             COALESCE(name, 'anonymous') AS display_name,
             COUNT(*) AS total
      FROM users
    `);
    strict.strictEqual(statement.columns[0]?.expression.kind, "case");
    strict.strictEqual(statement.columns[1]?.expression.kind, "call");
    strict.strictEqual(statement.columns[2]?.expression.kind, "call");
  });
});
