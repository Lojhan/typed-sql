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

  await it("tokenizes PostgreSQL geometric operators in prefix and binary positions", () => {
    for (const query of [
      "SELECT left_box <-> right_box AS distance FROM shapes",
      "SELECT @@ (bounds::box) AS center FROM shapes",
      "SELECT left_box <<| right_box AS below FROM shapes",
      "SELECT first_line ?|| second_line AS parallel FROM shapes",
      "SELECT # (outline::path) AS points FROM shapes",
    ]) {
      strict.doesNotThrow(() => parseStatement(query), query);
    }
  });

  await it("tokenizes PostgreSQL scalar prefix, shift, and concatenation operators", () => {
    for (const query of [
      "SELECT @ amount AS magnitude FROM measurements",
      "SELECT |/ variance AS deviation FROM measurements",
      "SELECT ||/ volume AS edge FROM measurements",
      "SELECT flags << 2 AS shifted FROM measurements",
      "SELECT payload || suffix AS combined FROM measurements",
    ]) {
      strict.doesNotThrow(() => parseStatement(query), query);
    }
  });

  await it("owns PostgreSQL array subscripts and slices", () => {
    const statement = parseStatement("SELECT scores[1], scores[2:4], scores[:3], scores[2:], matrix[1][2] FROM events");
    strict.strictEqual(statement.kind, "select");
    if (statement.kind !== "select") return;
    strict.deepStrictEqual(
      statement.columns.map(({ expression }) => expression.kind),
      ["subscript", "subscript", "subscript", "subscript", "subscript"],
    );
    const slice = statement.columns[1]?.expression;
    strict.strictEqual(slice?.kind === "subscript" ? slice.slice : undefined, true);
    const visited: string[] = [];
    walkStatement(statement, {
      expression(expression) {
        visited.push(expression.kind);
      },
    });
    strict.ok(visited.filter((kind) => kind === "subscript").length >= 5);
    strict.ok(visited.filter((kind) => kind === "literal").length >= 7);
    strict.throws(() => parseStatement("SELECT scores[] FROM events"), SqlParseError);
  });

  await it("owns PostgreSQL interval literals, fields, and precision", () => {
    const statement = parseStatement(`
      SELECT INTERVAL '1 day' AS plain,
             INTERVAL (3) '1.2345 seconds' AS prefix_precision,
             INTERVAL '1-2' YEAR TO MONTH AS year_month,
             INTERVAL '1 day 2:03:04.5678' DAY TO SECOND (3) AS day_second,
             CAST('2:03:04.567' AS INTERVAL HOUR TO SECOND(2)) AS cast_interval,
             '1 day'::INTERVAL DAY AS postgres_cast,
             interval(1) AS routine_call,
             interval(value) AS named_routine_call,
             interval(1, 2) AS multi_routine_call
    `);
    strict.strictEqual(statement.kind, "select");
    if (statement.kind !== "select") return;
    strict.deepStrictEqual(
      statement.columns.map(({ expression }) => expression.kind),
      ["cast", "cast", "cast", "cast", "cast", "cast", "call", "call", "call"],
    );
    strict.deepStrictEqual(
      statement.columns
        .slice(0, 5)
        .map(({ expression }) =>
          expression.kind === "cast" ? [expression.syntax, expression.databaseType.name.toLowerCase()] : undefined,
        ),
      [
        ["typed-literal", "interval"],
        ["typed-literal", "interval(3)"],
        ["typed-literal", "interval year to month"],
        ["typed-literal", "interval day to second(3)"],
        ["cast", "interval hour to second(2)"],
      ],
    );
    const visitedTypes: string[] = [];
    walkStatement(statement, {
      type(type) {
        visitedTypes.push(type.name.toLowerCase());
      },
    });
    strict.deepStrictEqual(visitedTypes, [
      "interval",
      "interval(3)",
      "interval year to month",
      "interval day to second(3)",
      "interval hour to second(2)",
      "interval day",
    ]);
    for (const fields of [
      "YEAR",
      "MONTH",
      "DAY",
      "HOUR",
      "MINUTE",
      "SECOND",
      "YEAR TO MONTH",
      "DAY TO HOUR",
      "DAY TO MINUTE",
      "DAY TO SECOND",
      "HOUR TO MINUTE",
      "HOUR TO SECOND",
      "MINUTE TO SECOND",
    ]) {
      strict.doesNotThrow(() => parseStatement(`SELECT INTERVAL '1' ${fields} AS value`), fields);
    }
    strict.throws(() => parseStatement("SELECT INTERVAL '1' YEAR TO DAY"), SqlParseError);
    strict.throws(() => parseStatement("SELECT INTERVAL '1' SECOND TO MINUTE"), SqlParseError);
    strict.throws(() => parseStatement("SELECT INTERVAL '1' DAY (3)"), SqlParseError);
    strict.throws(() => parseStatement("SELECT INTERVAL (3) '1' SECOND"), SqlParseError);
    strict.throws(() => parseStatement("SELECT INTERVAL (3.5) '1 second'"), SqlParseError);
    strict.throws(() => parseStatement("SELECT CAST('1' AS INTERVAL(3) SECOND)"), SqlParseError);
    strict.throws(() => parseStatement("SELECT CAST('1' AS INTERVAL SECOND trailing)"), SqlParseError);
    strict.doesNotThrow(() => parseStatement("SELECT CAST(ARRAY['1 day'] AS INTERVAL[]) AS interval_values"));
  });

  await it("owns PostgreSQL JSON and JSON-path typed literals", () => {
    const statement = parseStatement(`
      SELECT JSON '{"enabled":true}' AS document,
             JSONB '{"items":[1,2]}' AS binary_document,
             JSONPATH 'strict $.items[*] ? (@ > 1)' AS path
    `);
    strict.strictEqual(statement.kind, "select");
    if (statement.kind !== "select") return;
    strict.deepStrictEqual(
      statement.columns.map(({ expression }) =>
        expression.kind === "cast" ? [expression.syntax, expression.databaseType.name.toLowerCase()] : undefined,
      ),
      [
        ["typed-literal", "json"],
        ["typed-literal", "jsonb"],
        ["typed-literal", "jsonpath"],
      ],
    );
  });

  await it("owns PostgreSQL 17 SQL/JSON JSON_EXISTS syntax", () => {
    const statement = parseStatement(`
      SELECT JSON_EXISTS(
        $1 FORMAT JSON,
        $2 PASSING $3 AS threshold,
                   convert_to($4, 'UTF8') FORMAT JSON ENCODING UTF8 AS "document"
        UNKNOWN ON ERROR
      ) AS matches
    `);
    strict.strictEqual(statement.kind, "select");
    if (statement.kind !== "select") return;
    const expression = statement.columns[0]?.expression;
    strict.strictEqual(expression?.kind, "json-exists");
    if (expression?.kind !== "json-exists") return;
    strict.strictEqual(expression.context.format?.encoding, undefined);
    strict.strictEqual(expression.path.kind, "parameter");
    strict.deepStrictEqual(
      expression.passing.map(({ name, value }) => ({ name: name.name, encoding: value.format?.encoding })),
      [
        { name: "threshold", encoding: undefined },
        { name: "document", encoding: "UTF8" },
      ],
    );
    strict.strictEqual(expression.onError, "unknown");
    strict.ok(expression.range.end > expression.range.start);

    const visited: string[] = [];
    walkStatement(statement, {
      expression(node) {
        visited.push(node.kind);
      },
    });
    strict.deepStrictEqual(
      visited.filter((kind) => kind === "parameter"),
      ["parameter", "parameter", "parameter", "parameter"],
    );

    const quoted = parseStatement(`SELECT "JSON_EXISTS"('{}', '$') AS ordinary_call`);
    strict.strictEqual(quoted.kind === "select" ? quoted.columns[0]?.expression.kind : undefined, "call");
    const lowercase = parseStatement(`select json_exists('{}', '$' passing 1 as x false on error)`);
    strict.strictEqual(lowercase.kind === "select" ? lowercase.columns[0]?.expression.kind : undefined, "json-exists");
    for (const invalid of [
      "SELECT JSON_EXISTS('{}', '$' NULL ON ERROR)",
      "SELECT JSON_EXISTS('{}', '$' PASSING 1 x)",
      "SELECT JSON_EXISTS('{}' FORMAT JSON ENCODING LATIN1, '$')",
    ]) {
      strict.throws(() => parseStatement(invalid), SqlParseError, invalid);
    }
  });

  await it("owns parenthesized composite field selection", () => {
    const statement = parseStatement(
      'SELECT (profile).zip, (profile).location.latitude, (profile)."DisplayName" FROM people',
    );
    strict.strictEqual(statement.kind, "select");
    if (statement.kind !== "select") return;
    strict.deepStrictEqual(
      statement.columns.map(({ expression }) => expression.kind),
      ["field-access", "field-access", "field-access"],
    );
    const nested = statement.columns[1]?.expression;
    strict.strictEqual(
      nested?.kind === "field-access" && nested.expression.kind === "field-access"
        ? nested.expression.field.name
        : undefined,
      "location",
    );
    let fields = 0;
    walkStatement(statement, {
      expression(expression) {
        if (expression.kind === "field-access") fields += 1;
      },
    });
    strict.strictEqual(fields, 4);
  });

  await it("owns COLLATE and AT TIME ZONE expression modifiers", () => {
    const statement = parseStatement(`
      SELECT name COLLATE pg_catalog."C",
             created_at AT TIME ZONE 'UTC',
             (created_at AT TIME ZONE zone_name) COLLATE "default",
             created_at AT LOCAL
      FROM events
    `);
    strict.strictEqual(statement.kind, "select");
    if (statement.kind !== "select") return;
    strict.deepStrictEqual(
      statement.columns.map(({ expression }) => expression.kind),
      ["collate", "at-time-zone", "collate", "at-time-zone"],
    );
    const nested = statement.columns[2]?.expression;
    strict.strictEqual(nested?.kind === "collate" ? nested.expression.kind : undefined, "at-time-zone");
    const visited: string[] = [];
    walkStatement(statement, {
      expression(expression) {
        visited.push(expression.kind);
      },
    });
    strict.strictEqual(visited.filter((kind) => kind === "collate").length, 2);
    strict.strictEqual(visited.filter((kind) => kind === "at-time-zone").length, 3);
  });

  await it("owns quantified and row comparisons", () => {
    const statement = parseStatement(`
      SELECT id = ANY(scores),
             id <> ALL(ARRAY[1, 2]),
             id = SOME(SELECT user_id FROM ages),
             (id, active) IS DISTINCT FROM (2, false),
             (id, active) IN ((1, true), (2, false)),
             (id, active) IN (SELECT user_id, active FROM ages)
      FROM events
    `);
    strict.strictEqual(statement.kind, "select");
    if (statement.kind !== "select") return;
    strict.deepStrictEqual(
      statement.columns
        .slice(0, 3)
        .map(({ expression }) =>
          expression.kind === "quantified-comparison" ? expression.quantifier : expression.kind,
        ),
      ["any", "all", "some"],
    );
    strict.strictEqual(statement.columns[3]?.expression.kind, "binary");
    strict.strictEqual(statement.columns[4]?.expression.kind, "in");
    strict.strictEqual(statement.columns[5]?.expression.kind, "in");
    let quantified = 0;
    walkStatement(statement, {
      expression(expression) {
        if (expression.kind === "quantified-comparison") quantified += 1;
      },
    });
    strict.strictEqual(quantified, 3);
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
