import { describe, it, strict } from "poku";
import { parseSelect, parseStatement, SqlParseError, tokenize } from "../src/index.js";

await describe("PostgreSQL parser", async () => {
  await it("tokenizes comments, quoted identifiers, strings, parameters, and source ranges", async () => {
    const tokens = tokenize("-- lead\nSELECT \"User\".id, 'it''s', $12 /* tail */");
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
    strict.deepStrictEqual(
      statement.joins.map((join) => join.kind),
      ["inner", "right"],
    );
    strict.strictEqual(statement.where?.kind, "binary");
    strict.strictEqual(statement.groupBy.length, 2);
    strict.strictEqual(statement.having?.kind, "binary");
    strict.deepStrictEqual(
      statement.orderBy.map((item) => item.direction),
      ["desc", "asc"],
    );
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
        (error: unknown) =>
          error instanceof SqlParseError &&
          message.test(error.message) &&
          error.range.start >= 0 &&
          error.range.line >= 1,
        `Expected a stable parse error for ${JSON.stringify(source)}`,
      );
    }
  });

  await it("parses CTEs, derived tables, correlated subqueries, JOIN USING, and star expansion", () => {
    const statement = parseSelect(`
      WITH recent(id, name) AS (
        SELECT u.id, u.name FROM users u WHERE u.id IN (SELECT a.user_id FROM ages a)
      )
      SELECT derived.*, r.name
      FROM (SELECT id FROM users WHERE EXISTS (SELECT 1 FROM ages WHERE ages.user_id = users.id)) AS derived
      JOIN recent r USING (id)
    `);
    strict.strictEqual(statement.with?.queries[0]?.name.name, "recent");
    strict.strictEqual(statement.with?.queries[0]?.columns.length, 2);
    strict.strictEqual(statement.from?.kind, "subquery");
    strict.strictEqual(statement.joins[0]?.using?.[0]?.name, "id");
    strict.strictEqual(statement.columns[0]?.expression.kind, "star");
  });

  await it("parses INSERT, UPDATE, DELETE, VALUES, SELECT sources, and RETURNING", () => {
    const insert = parseStatement(
      "INSERT INTO users AS u (name, age) VALUES ('Ada', 37), ('Grace', NULL) RETURNING u.*",
    );
    strict.strictEqual(insert.kind, "insert");
    if (insert.kind === "insert") {
      strict.strictEqual(insert.source.kind, "values");
      strict.strictEqual(insert.returning[0]?.expression.kind, "star");
    }
    const insertSelect = parseStatement("INSERT INTO users (name) SELECT name FROM archived_users RETURNING id");
    strict.strictEqual(insertSelect.kind === "insert" && insertSelect.source.kind, "select");
    const update = parseStatement(
      "UPDATE users u SET name = 'Ada', age = age + 1 FROM ages a WHERE a.user_id = u.id RETURNING u.id, u.name",
    );
    strict.strictEqual(update.kind === "update" && update.assignments.length, 2);
    const deletion = parseStatement("DELETE FROM users u USING ages a WHERE a.user_id = u.id RETURNING u.*");
    strict.strictEqual(deletion.kind === "delete" && deletion.using.length, 1);
  });

  await it("parses PostgreSQL arrays, JSON operators, FILTER, and window expressions", () => {
    const statement = parseSelect(`
      SELECT ARRAY[1, 2, 3] AS ids,
             payload->>'name' AS name,
             COUNT(*) FILTER (WHERE active) OVER (PARTITION BY team_id ORDER BY created_at DESC) AS active_count
      FROM events
      WHERE payload @> '{"active":true}'::jsonb
    `);
    strict.strictEqual(statement.columns[0]?.expression.kind, "array");
    strict.strictEqual(statement.columns[1]?.expression.kind, "binary");
    const count = statement.columns[2]?.expression;
    strict.strictEqual(count?.kind, "call");
    if (count?.kind === "call") {
      strict.ok(count.filter !== undefined);
      strict.ok(count.over !== undefined && "partitionBy" in count.over);
    }
  });

  await it("enforces deterministic parser resource limits", () => {
    strict.throws(
      () => parseSelect("SELECT 1", { maxSqlLength: 4 }),
      (error: unknown) => error instanceof SqlParseError && error.code === "TSQ002",
    );
    strict.throws(
      () => parseSelect("SELECT 1, 2", { maxTokens: 2 }),
      (error: unknown) => error instanceof SqlParseError && error.code === "TSQ002",
    );
    strict.throws(
      () => parseSelect(`SELECT ${"(".repeat(20)}1${")".repeat(20)} AS value`, { maxDepth: 8 }),
      (error: unknown) => error instanceof SqlParseError && error.code === "TSQ002",
    );
  });
});
