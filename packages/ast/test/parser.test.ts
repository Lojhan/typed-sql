import { describe, it, strict } from "poku";
import { parseSelect, SqlParseError, tokenize } from "../src/index.js";

await describe("PostgreSQL parser", async () => {
  await it("tokenizes comments, quoted identifiers, strings, parameters, and source ranges", async () => {
    const tokens = tokenize('-- lead\nSELECT "User".id, \'it\'\'s\', $12 /* tail */');
    strict.strictEqual(tokens[0]?.value, "SELECT");
    strict.deepStrictEqual(tokens[0]?.range, { start: 8, end: 14, line: 2, column: 1 });
    strict.strictEqual(tokens[1]?.kind, "quoted-identifier");
    strict.strictEqual(tokens[1]?.value, "User");
    strict.strictEqual(tokens.find((token) => token.kind === "string")?.value, "it's");
    strict.strictEqual(tokens.find((token) => token.kind === "parameter")?.value, "12");
  });

  await it("parses the complete supported SELECT clause surface", async () => {
    const statement = parseSelect(`
      SELECT DISTINCT u.id, CAST(u.age AS BIGINT) AS cast_age, u.age::BIGINT AS age
      FROM public.users AS u
      INNER JOIN ages a ON u.id = a.user_id
      RIGHT OUTER JOIN scores s ON s.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id, u.age
      HAVING COUNT(*) > 0
      ORDER BY u.id DESC, u.age ASC LIMIT 10 OFFSET 2;
    `);
    strict.strictEqual(statement.distinct, true);
    strict.strictEqual(statement.from?.schema?.name, "public");
    strict.strictEqual(statement.columns[1]?.expression.kind, "cast");
    strict.strictEqual(statement.columns[2]?.expression.kind, "cast");
    strict.deepStrictEqual(statement.joins.map((join) => join.kind), ["inner", "right"]);
    strict.strictEqual(statement.where?.kind, "binary");
    strict.strictEqual(statement.groupBy.length, 2);
    strict.strictEqual(statement.having?.kind, "binary");
    strict.deepStrictEqual(statement.orderBy.map((item) => item.direction), ["desc", "asc"]);
    strict.strictEqual(statement.limit?.kind, "literal");
    strict.strictEqual(statement.offset?.kind, "literal");
  });

  await it("parses CASE, calls, literals, stars, aliases, unary and precedence", async () => {
    const statement = parseSelect(`
      SELECT CASE age WHEN 1 THEN true ELSE false END flag,
             CASE WHEN age IS NOT NULL THEN +age END AS maybe_age,
             COALESCE(name, 'anonymous') display_name,
             COUNT(*) total,
             u.*,
             NULL AS missing,
             -age + 2 * 3 AS score
      FROM users u FULL JOIN ages a ON true
    `);
    strict.strictEqual(statement.columns[0]?.expression.kind, "case");
    strict.strictEqual(statement.columns[1]?.expression.kind, "case");
    strict.strictEqual(statement.columns[2]?.expression.kind, "call");
    strict.strictEqual(statement.columns[4]?.expression.kind, "star");
    strict.strictEqual(statement.columns[5]?.expression.kind, "literal");
    strict.strictEqual(statement.columns[6]?.expression.kind, "binary");
    strict.strictEqual(statement.joins[0]?.kind, "full");
  });

  await it("reports stable parse and tokenize ranges", async () => {
    for (const [source, message] of [
      ["SELECT", /Expected expression/],
      ["SELECT CASE END", /CASE requires at least one WHEN/],
      ["SELECT CAST(1 AS)", /Expected identifier/],
      ["SELECT (1", /Expected \)/],
      ["SELECT 1 trailing garbage", /Expected end of query/],
      ["SELECT 'unterminated", /Unterminated string/],
      ["SELECT /* unterminated", /Unterminated block comment/],
    ] as const) {
      strict.throws(
        () => parseSelect(source),
        (error: unknown) => error instanceof SqlParseError
          && message.test(error.message)
          && error.range.start >= 0
          && error.range.line >= 1,
      );
    }
  });
});
