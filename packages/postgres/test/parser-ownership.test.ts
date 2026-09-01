import { describe, it, strict } from "poku";
import { assertOwnedParserCorpus } from "../../../test/helpers/parser-corpus.js";
import { parseStatement as parseCompatibilityStatement } from "../../ast/src/index.js";
import { parseStatement, SqlParseError, tokenize, walkStatement } from "../src/parser/index.js";

await describe("PostgreSQL-owned parser", async () => {
  await it("matches the transition corpus without using the compatibility parser in production", () => {
    for (const source of [
      "SELECT DISTINCT ON (team_id) id FROM users ORDER BY team_id, id",
      "SELECT payload->>'name' AS name FROM events WHERE payload @> '{}'::jsonb",
      "SELECT id FROM users FOR NO KEY UPDATE OF users SKIP LOCKED",
      "INSERT INTO users (id) VALUES ($1) RETURNING id",
    ]) {
      const statement = parseStatement(source);
      strict.deepStrictEqual(statement, parseCompatibilityStatement(source));
      strict.ok(Object.isFrozen(statement));
      strict.ok(Object.isFrozen(statement.range));
    }
  });

  await it("retains bounded deterministic diagnostics and PostgreSQL lexical behavior", () => {
    strict.strictEqual(tokenize('SELECT "user".id WHERE id = $1')[1]?.kind, "quoted-identifier");
    strict.throws(
      () => parseStatement(`SELECT ${"(".repeat(10)}1${")".repeat(10)}`, { maxDepth: 4 }),
      (error: unknown) => error instanceof SqlParseError && error.code === "TSQ002",
    );
  });

  await it("owns named and explicit variadic function arguments", () => {
    const named = parseStatement("SELECT format_value(value => 1, prefix := 'id') AS label");
    strict.strictEqual(named.kind, "select");
    if (named.kind !== "select") return;
    const expression = named.columns[0]?.expression;
    strict.strictEqual(expression?.kind, "call");
    if (expression?.kind !== "call") return;
    strict.deepStrictEqual(
      expression.argumentNames?.map((name) => name?.name),
      ["value", "prefix"],
    );

    const variadic = parseStatement("SELECT sum_many(VARIADIC ARRAY[1, 2]) AS total");
    strict.strictEqual(variadic.kind, "select");
    if (variadic.kind !== "select") return;
    const variadicCall = variadic.columns[0]?.expression;
    strict.strictEqual(variadicCall?.kind === "call" ? variadicCall.variadic : undefined, true);

    strict.throws(() => parseStatement("SELECT format_value(value => 1, 'id')"), SqlParseError);
    strict.throws(() => parseStatement("SELECT sum_many(VARIADIC ARRAY[1], 2)"), SqlParseError);
  });

  await it("tokenizes PostgreSQL range, network, text-search, and JSON-path operators", () => {
    for (const query of [
      "SELECT left_range << right_range AS before FROM periods",
      "SELECT left_range -|- right_range AS adjacent FROM periods",
      "SELECT document @@ query AS matches FROM search_documents",
      "SELECT payload @? path AS matches FROM documents",
      "SELECT payload #- ARRAY['private'] AS redacted FROM documents",
      "SELECT !! (query::tsquery) AS negated FROM search_documents",
    ]) {
      strict.doesNotThrow(() => parseStatement(query), query);
    }
  });

  await it("preserves PostgreSQL compound-query precedence and parentheses", () => {
    const intersectionFirst = parseStatement("SELECT 1 INTERSECT SELECT 2 UNION SELECT 3 ORDER BY 1");
    strict.strictEqual(intersectionFirst.kind, "select");
    if (intersectionFirst.kind !== "select") return;
    strict.deepStrictEqual(
      intersectionFirst.compounds.map(({ operator }) => operator),
      ["intersect", "union"],
    );
    strict.ok(intersectionFirst.compounds.every(({ statement }) => statement.compounds.length === 0));
    strict.strictEqual(intersectionFirst.orderBy.length, 1);

    const unionFirst = parseStatement("SELECT 1 UNION SELECT 2 INTERSECT SELECT 3");
    strict.strictEqual(unionFirst.kind, "select");
    if (unionFirst.kind !== "select") return;
    strict.deepStrictEqual(
      unionFirst.compounds.map(({ operator }) => operator),
      ["union"],
    );
    strict.deepStrictEqual(
      unionFirst.compounds[0]?.statement.compounds.map(({ operator }) => operator),
      ["intersect"],
    );

    const rightGrouped = parseStatement("SELECT 1 UNION (SELECT 2 EXCEPT SELECT 3) ORDER BY 1");
    strict.strictEqual(rightGrouped.kind, "select");
    if (rightGrouped.kind !== "select") return;
    strict.deepStrictEqual(
      rightGrouped.compounds[0]?.statement.compounds.map(({ operator }) => operator),
      ["except"],
    );
    strict.strictEqual(rightGrouped.orderBy.length, 1);

    const leftGrouped = parseStatement("(SELECT 1 UNION SELECT 2) INTERSECT SELECT 3");
    strict.strictEqual(leftGrouped.kind, "select");
    if (leftGrouped.kind !== "select") return;
    strict.deepStrictEqual(
      leftGrouped.compounds.map(({ operator }) => operator),
      ["union", "intersect"],
    );
  });

  await it("passes the characterized parser, tokenizer, walker, and fuzz corpus", () => {
    assertOwnedParserCorpus({
      dialect: "postgres",
      parseStatement,
      tokenize,
      walkStatement,
      isParseError: (error) => error instanceof SqlParseError,
      compareWithCompatibilityParser: false,
    });
  });

  await it("walks PostgreSQL grouping, window-frame, function-relation, and sampling nodes", () => {
    const statement = parseStatement(`
      SELECT MODE() WITHIN GROUP (ORDER BY u.id) AS modal_id,
             ROW_NUMBER() OVER (
               ORDER BY u.id ROWS BETWEEN $1 PRECEDING AND $2 FOLLOWING EXCLUDE TIES
             ) AS position
      FROM users u TABLESAMPLE SYSTEM($3) REPEATABLE($4)
      CROSS JOIN ROWS FROM (
        jsonb_to_recordset('[]'::jsonb) AS (entry_id integer),
        generate_series(1, 2)
      ) WITH ORDINALITY AS expanded(entry_id, sequence, ordinal)
      GROUP BY GROUPING SETS ((u.id), ROLLUP(u.id), CUBE(u.id), ())
    `);
    const visited = { expressions: 0, tables: 0, types: [] as string[] };
    walkStatement(statement, {
      expression() {
        visited.expressions += 1;
      },
      table() {
        visited.tables += 1;
      },
      type(type) {
        visited.types.push(type.name);
      },
    });
    strict.ok(visited.expressions > 15);
    strict.strictEqual(visited.tables, 2);
    strict.deepStrictEqual(visited.types, ["jsonb", "integer"]);
  });

  await it("owns PostgreSQL conflict, row-assignment, MERGE, and RETURNING alias syntax", () => {
    const conflict = parseStatement(`
      INSERT INTO users (id, name) OVERRIDING SYSTEM VALUE VALUES ($1, $2)
      ON CONFLICT (id COLLATE "C" int4_ops) WHERE id > 0
      DO UPDATE SET (name, id) = ROW(excluded.name, excluded.id)
      RETURNING WITH (OLD AS previous, NEW AS current) previous.*, current.*
    `);
    strict.strictEqual(conflict.kind, "insert");
    if (conflict.kind !== "insert") return;
    strict.strictEqual(conflict.overriding, "system");
    strict.strictEqual(conflict.conflict?.target?.kind, "inference");
    strict.strictEqual(conflict.conflict?.action.kind, "update");
    strict.strictEqual(conflict.returningAliases?.old?.name, "previous");
    let conflictExpressions = 0;
    walkStatement(conflict, {
      expression() {
        conflictExpressions += 1;
      },
    });
    strict.ok(conflictExpressions >= 8);
    strict.doesNotThrow(() =>
      parseStatement(
        "INSERT INTO users (name) OVERRIDING USER VALUE DEFAULT VALUES ON CONFLICT ON CONSTRAINT users_pkey DO NOTHING RETURNING WITH (NEW AS current) current.name",
      ),
    );
    strict.doesNotThrow(() => parseStatement("UPDATE users SET (name, id) = (SELECT name, id FROM users)"));
    let updateExpressions = 0;
    walkStatement(
      parseStatement(
        "UPDATE users u SET name = a.label FROM ages a JOIN users other ON other.id = a.user_id WHERE u.id = a.user_id RETURNING u.id",
      ),
      {
        expression() {
          updateExpressions += 1;
        },
      },
    );
    strict.ok(updateExpressions >= 6);

    const merge = parseStatement(`
      MERGE INTO users target USING ages source ON target.id = source.user_id
      WHEN MATCHED AND target.name <> source.label THEN UPDATE SET name = source.label
      WHEN NOT MATCHED BY TARGET THEN INSERT (name) OVERRIDING USER VALUE VALUES (source.label)
      WHEN NOT MATCHED BY SOURCE THEN DELETE
      RETURNING merge_action() AS action, target.*
    `);
    strict.strictEqual(merge.kind, "merge");
    if (merge.kind !== "merge") return;
    strict.deepStrictEqual(
      merge.clauses.map(({ match, action }) => [match, action.kind]),
      [
        ["matched", "update"],
        ["not-matched-target", "insert"],
        ["not-matched-source", "delete"],
      ],
    );
    let expressions = 0;
    walkStatement(merge, {
      expression() {
        expressions += 1;
      },
    });
    strict.ok(expressions >= 8);

    const valuesSource = parseStatement(
      "MERGE INTO ONLY users * AS target USING (VALUES (1, 'Ada'), (2, 'Grace')) AS source(id, name) ON target.id = source.id WHEN MATCHED THEN DO NOTHING",
    );
    strict.strictEqual(valuesSource.kind, "merge");
    if (valuesSource.kind !== "merge") return;
    strict.strictEqual(valuesSource.table.only, true);
    strict.strictEqual(valuesSource.table.includeDescendants, true);
    strict.strictEqual(valuesSource.source.kind, "values");
    let valuesExpressions = 0;
    walkStatement(valuesSource, {
      expression() {
        valuesExpressions += 1;
      },
    });
    strict.ok(valuesExpressions >= 5);
    strict.doesNotThrow(() =>
      parseStatement("MERGE INTO users u USING ages a ON u.id = a.user_id WHEN NOT MATCHED THEN INSERT DEFAULT VALUES"),
    );
  });
});
