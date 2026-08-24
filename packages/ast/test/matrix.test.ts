import { describe, it, strict } from "poku";
import { parseSelect, parseStatement, SqlParseError, tokenize } from "../src/index.js";

function parseFails(source: string, pattern: RegExp): void {
  strict.throws(
    () => parseStatement(source),
    (error: unknown) => error instanceof SqlParseError && pattern.test(error.message),
    `Expected ${JSON.stringify(source)} to fail with ${pattern}`,
  );
}

await describe("PostgreSQL grammar branch matrix", async () => {
  await it("covers SELECT modifiers, relation variants, joins, windows, and ordering", () => {
    const distinct = parseSelect(`
      SELECT DISTINCT ON (u.team_id, u.created_at) u.id
      FROM LATERAL (SELECT id, team_id, created_at FROM public.users) AS u,
           public.teams t
      LEFT OUTER JOIN public.accounts AS a USING (id, team_id)
      CROSS JOIN public.flags f
      WHERE u.id NOT BETWEEN 1 AND 10
      GROUP BY u.id
      HAVING COUNT(DISTINCT u.id) > 0
      WINDOW activity AS (PARTITION BY u.team_id ORDER BY u.created_at ASC NULLS FIRST)
      ORDER BY u.id NULLS LAST
    `);
    strict.strictEqual(distinct.distinctOn.length, 2);
    strict.strictEqual(distinct.from?.kind, "subquery");
    strict.deepStrictEqual(distinct.joins.map((join) => join.kind), ["cross", "left", "cross"]);
    strict.strictEqual(distinct.windows[0]?.name.name, "activity");
    strict.strictEqual(distinct.orderBy[0]?.nulls, "last");

    const all = parseSelect("SELECT ALL 1 AS one WHERE false ORDER BY one ASC");
    strict.strictEqual(all.distinct, false);
    strict.strictEqual(all.from, undefined);
    strict.strictEqual(all.where?.kind, "literal");
  });

  await it("covers expression and literal variants", () => {
    const statement = parseSelect(`
      SELECT
        id NOT IN (1, 2), id IN (SELECT id FROM users),
        id BETWEEN 1 AND 2, name NOT LIKE 'x%', name ILIKE 'a%', name NOT ILIKE 'b%',
        name SIMILAR TO '(a|b)%', name NOT SIMILAR TO '(c|d)%',
        id IS NULL, id IS NOT NULL, id IS DISTINCT FROM other_id, id IS NOT DISTINCT FROM other_id,
        EXISTS (SELECT 1), (SELECT 1), (1, 'two'), ROW(), ROW(1, 2), ARRAY[],
        public.calculate(), COUNT(DISTINCT id) FILTER (WHERE active) OVER activity,
        NOT active, +id, -id, ~id, false, DEFAULT, $2,
        1.25e+2, E'line\\nnext', $body$dollar text$body$
      FROM "Users" AS u
    `);
    strict.strictEqual(statement.columns.length, 30);
    strict.strictEqual(statement.columns[0]?.expression.kind, "in");
    strict.strictEqual(statement.columns[12]?.expression.kind, "exists");
    strict.strictEqual(statement.columns[13]?.expression.kind, "subquery");
    strict.strictEqual(statement.columns[14]?.expression.kind, "row");
    strict.strictEqual(statement.columns[17]?.expression.kind, "array");
    strict.strictEqual(statement.columns[18]?.expression.kind, "call");
  });

  await it("covers type-name forms and both cast syntaxes", () => {
    const statement = parseSelect(`
      SELECT value::public.money_amount,
             value::numeric(14, 2)[],
             CAST(value AS timestamp without time zone),
             CAST(value AS double precision),
             CAST(value AS character varying(120))
      FROM values_table
    `);
    strict.deepStrictEqual(statement.columns.map((item) => item.expression.kind), ["cast", "cast", "cast", "cast", "cast"]);
  });

  await it("covers CTE and data-changing statement variants", () => {
    const insert = parseStatement(`
      WITH source_rows() AS (SELECT 'Ada' AS name)
      INSERT INTO public.users () VALUES (), () RETURNING *
    `);
    strict.strictEqual(insert.kind, "insert");
    const defaults = parseStatement("INSERT INTO users DEFAULT VALUES");
    strict.strictEqual(defaults.kind === "insert" && defaults.source.kind, "default-values");
    const update = parseStatement(`
      WITH ids AS (SELECT id FROM users)
      UPDATE public.users AS u SET name = 'Ada'
      FROM ids RIGHT JOIN audit a ON a.user_id = ids.id
      WHERE u.id = ids.id
    `);
    strict.strictEqual(update.kind === "update" && update.joins[0]?.kind, "right");
    const deletion = parseStatement("WITH doomed AS (SELECT id FROM users) DELETE FROM users USING doomed, audit");
    strict.strictEqual(deletion.kind === "delete" && deletion.using.length, 2);
    const recursive = parseStatement("WITH RECURSIVE tree(id) AS (SELECT 1) SELECT id FROM tree");
    strict.strictEqual(recursive.with?.recursive, true);
  });

  await it("covers deterministic invalid syntax branches", () => {
    for (const [source, pattern] of [
      ["MERGE INTO users", /Expected SELECT, INSERT, UPDATE, or DELETE/],
      ["SELECT * FROM (UPDATE users SET name = 'x') u", /FROM subquery must be SELECT/],
      ["SELECT EXISTS (DELETE FROM users)", /EXISTS requires a SELECT/],
      ["SELECT (UPDATE users SET name = 'x')", /Scalar subquery must be SELECT/],
      ["SELECT id IN (UPDATE users SET name = 'x')", /IN subquery must be SELECT/],
      ["INSERT INTO users WITH changed AS (UPDATE users SET name = 'x') UPDATE users SET name = 'y'", /INSERT source must be SELECT/],
      ["INSERT INTO users", /Expected VALUES, DEFAULT VALUES, or SELECT/],
      ["SELECT * FROM users JOIN accounts", /JOIN requires ON or USING/],
      ["SELECT * FROM (users) u", /parenthesized FROM item must be a SELECT/],
      ["SELECT id IN ()", /IN requires at least one value/],
      ["SELECT CAST(value AS numeric(10, 2)", /Unterminated type modifier|Expected \)/],
      ["SELECT CAST(value AS text extra)", /Expected \) after type name/],
    ] as const) parseFails(source, pattern);
    strict.throws(() => parseSelect("DELETE FROM users"), /Expected SELECT, found DELETE/);
  });

  await it("covers scanner escapes, nesting, numeric errors, and option validation", () => {
    const tokens = tokenize(`/* outer /* inner */ done */ SELECT "a""b", E'\\t', 2e-3, $x$body$x$`);
    strict.strictEqual(tokens.find((token) => token.kind === "quoted-identifier")?.value, 'a"b');
    strict.strictEqual(tokens.filter((token) => token.kind === "string")[0]?.value, "\t");
    strict.strictEqual(tokens.filter((token) => token.kind === "string")[1]?.value, "body");
    for (const operation of [
      () => tokenize("SELECT 1", { maxSqlLength: 0 }),
      () => tokenize("SELECT 1", { maxTokens: Number.NaN }),
      () => parseSelect("SELECT 1", { maxDepth: 0 }),
      () => tokenize("SELECT $0"),
      () => tokenize("SELECT 1e+"),
      () => tokenize("SELECT $tag$unterminated"),
      () => tokenize('SELECT "unterminated'),
      () => tokenize("SELECT `invalid`"),
    ]) strict.throws(operation);
  });

  await it("tokenizes MySQL placeholders and quoting without weakening PostgreSQL defaults", () => {
    const statement = parseSelect('SELECT `user`.`id`, "text" AS label FROM `users` AS `user` WHERE `user`.`id` = ? LIMIT 5, 10', { syntax: "mysql" });
    strict.strictEqual(statement.columns[0]?.expression.kind, "column");
    strict.strictEqual(statement.columns[1]?.expression.kind, "literal");
    strict.strictEqual(statement.where?.kind, "binary");
    strict.strictEqual(statement.offset?.kind, "literal");
    strict.strictEqual(statement.limit?.kind, "literal");
    strict.strictEqual(tokenize("SELECT payload ? 'key'").some((token) => token.kind === "operator" && token.value === "?"), true);
  });
});
