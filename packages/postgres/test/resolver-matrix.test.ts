import { describe, it, strict } from "poku";
import type { SchemaSnapshot } from "../../schema/src/index.js";
import { postgresServerEvidence } from "../src/capabilities.js";
import { parseSelect, parseStatement } from "../src/parser/index.js";
import { resolveSelect, resolveStatement } from "../src/resolver.js";

const schema = {
  formatVersion: 1,
  dialect: "postgres",
  tables: {
    users: {
      name: "users",
      columns: {
        id: { name: "id", databaseType: "integer", tsType: "number", nullable: false },
        name: { name: "name", databaseType: "text", tsType: "string", nullable: false },
        age: { name: "age", databaseType: "integer", tsType: "number", nullable: true },
        active: { name: "active", databaseType: "boolean", tsType: "boolean", nullable: false },
        payload: { name: "payload", databaseType: "jsonb", tsType: "unknown", nullable: false },
        scores: {
          name: "scores",
          databaseType: "integer[]",
          tsType: "readonly (number)[]",
          nullable: false,
          array: true,
        },
      },
    },
    accounts: {
      name: "accounts",
      columns: {
        id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
        label: { name: "label", databaseType: "text", tsType: "string", nullable: true },
      },
    },
  },
  functions: {
    "public.label_for(integer)": {
      schema: "public",
      name: "label_for",
      argumentTypes: ["integer"],
      databaseReturnType: "text",
      returnType: "string",
      nullable: false,
    },
    "choose(integer)": {
      name: "choose",
      argumentTypes: ["integer"],
      databaseReturnType: "integer",
      returnType: "number",
      nullable: false,
    },
    "choose(boolean)": {
      name: "choose",
      argumentTypes: ["boolean"],
      databaseReturnType: "boolean",
      returnType: "boolean",
      nullable: false,
    },
    "one_arg(text)": { name: "one_arg", argumentTypes: ["text"], returnType: "string", nullable: true },
  },
} as const satisfies SchemaSnapshot;

function codes(sql: string): readonly string[] {
  return resolveStatement(parseStatement(sql), schema).diagnostics.map((diagnostic) => diagnostic.code);
}

await describe("PostgreSQL resolver branch matrix", async () => {
  await it("infers set-operation rows and diagnoses incompatible arity", () => {
    const compound = resolveSelect(
      parseSelect("SELECT 1 AS value UNION ALL SELECT 'two' AS ignored INTERSECT SELECT 3 AS final_name"),
      schema,
    );
    strict.deepStrictEqual(compound.diagnostics, []);
    strict.strictEqual(compound.columns[0]?.name, "value");
    strict.strictEqual(compound.columns[0]?.tsType, "string | number");
    const invalid = resolveSelect(parseSelect("SELECT id FROM users UNION SELECT id, name FROM users"), schema);
    strict.ok(invalid.diagnostics.some(({ code }) => code === "TSQ214"));
  });

  await it("infers recursive CTE seeds and members and rejects invalid recursive shapes", () => {
    const recursive = resolveSelect(
      parseSelect(`
        WITH RECURSIVE counter(n) AS (
          SELECT 1 AS n
          UNION ALL
          SELECT n + 1 AS n FROM counter WHERE n < 3
        )
        SELECT n FROM counter
      `),
      schema,
    );
    strict.deepStrictEqual(recursive.diagnostics, []);
    strict.strictEqual(recursive.columns[0]?.tsType, "number");

    const missingKeyword = resolveSelect(
      parseSelect("WITH counter(n) AS (SELECT 1 AS n UNION ALL SELECT n + 1 AS n FROM counter) SELECT n FROM counter"),
      schema,
    );
    strict.ok(missingKeyword.diagnostics.some(({ code }) => code === "TSQ220"));
    const invalidOperator = resolveSelect(
      parseSelect(
        "WITH RECURSIVE counter(n) AS (SELECT 1 AS n INTERSECT SELECT n + 1 AS n FROM counter) SELECT n FROM counter",
      ),
      schema,
    );
    strict.ok(invalidOperator.diagnostics.some(({ code }) => code === "TSQ220"));
    for (const invalidShape of [
      "WITH RECURSIVE counter(n) AS (SELECT n FROM counter) SELECT n FROM counter",
      "WITH RECURSIVE counter(n) AS (SELECT 1 AS n UNION ALL SELECT left_side.n AS n FROM counter left_side JOIN counter right_side ON true) SELECT n FROM counter",
      "WITH RECURSIVE counter(n) AS (SELECT 1 AS n UNION ALL SELECT n + 1 AS n FROM counter UNION ALL SELECT 2 AS n) SELECT n FROM counter",
    ]) {
      const invalid = resolveSelect(parseSelect(invalidShape), schema);
      strict.ok(invalid.diagnostics.some(({ code }) => code === "TSQ220"));
    }
  });

  await it("parses SEARCH and CYCLE and exposes their generated columns conservatively", () => {
    const result = resolveSelect(
      parseSelect(`
        WITH RECURSIVE tree(id) AS (
          SELECT 1 AS id
          UNION ALL
          SELECT id + 1 AS id FROM tree WHERE id < 3
        ) SEARCH DEPTH FIRST BY id SET traversal
          CYCLE id SET is_cycle USING cycle_path
        SELECT id, traversal, is_cycle, cycle_path FROM tree
      `),
      schema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, tsType }) => ({ name, tsType })),
      [
        { name: "id", tsType: "number" },
        { name: "traversal", tsType: "unknown" },
        { name: "is_cycle", tsType: "boolean" },
        { name: "cycle_path", tsType: "unknown" },
      ],
    );

    const customMarks = resolveSelect(
      parseSelect(`
        WITH RECURSIVE tree(id) AS (
          SELECT 1 AS id
          UNION ALL
          SELECT id + 1 AS id FROM tree WHERE id < 3
        ) SEARCH BREADTH FIRST BY id SET traversal
          CYCLE id SET is_cycle TO 'Y' DEFAULT 'N' USING cycle_path
        SELECT traversal, is_cycle, cycle_path FROM tree
      `),
      schema,
    );
    strict.deepStrictEqual(customMarks.diagnostics, []);
    strict.deepStrictEqual(
      customMarks.columns.map(({ name, tsType }) => ({ name, tsType })),
      [
        { name: "traversal", tsType: "unknown" },
        { name: "is_cycle", tsType: "string" },
        { name: "cycle_path", tsType: "unknown" },
      ],
    );

    for (const invalid of [
      "WITH RECURSIVE tree(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM tree) SEARCH DEPTH FIRST BY missing SET traversal SELECT id FROM tree",
      "WITH RECURSIVE tree(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM tree) CYCLE missing SET is_cycle USING cycle_path SELECT id FROM tree",
      "WITH RECURSIVE tree(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM tree) SEARCH DEPTH FIRST BY id SET id SELECT id FROM tree",
    ]) {
      const invalidResult = resolveSelect(parseSelect(invalid), schema);
      strict.ok(invalidResult.diagnostics.some(({ code }) => code === "TSQ101" || code === "TSQ105"));
    }
  });

  await it("validates CTE declarations and data-changing CTE result contracts", () => {
    const result = resolveStatement(
      parseStatement(`
      WITH duplicate(a, b) AS (SELECT id FROM users),
           duplicate AS (DELETE FROM users WHERE false)
      SELECT * FROM duplicate
    `),
      schema,
    );
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ211"));
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ212"));
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ213"));
    const materialized = resolveSelect(
      parseSelect(
        "WITH active AS MATERIALIZED (SELECT id FROM users), names AS NOT MATERIALIZED (SELECT name FROM users) SELECT active.id, names.name FROM active CROSS JOIN names",
      ),
      schema,
    );
    strict.deepStrictEqual(materialized.diagnostics, []);
    strict.ok(
      codes("WITH tree AS (SELECT 1 AS id) SEARCH DEPTH FIRST BY id SET traversal SELECT id FROM tree").includes(
        "TSQ220",
      ),
    );
  });

  await it("covers INSERT sources, defaults, target validation, UPDATE joins, and DELETE USING", () => {
    const defaults = resolveStatement(parseStatement("INSERT INTO users DEFAULT VALUES"), schema);
    strict.strictEqual(defaults.resultKind, "command");
    const allColumns = resolveStatement(
      parseStatement("INSERT INTO users VALUES (1, 'Ada', NULL, true, '{}'::jsonb, ARRAY[1])"),
      schema,
    );
    strict.deepStrictEqual(allColumns.diagnostics, []);
    strict.deepStrictEqual(
      resolveStatement(parseStatement("INSERT INTO users VALUES (1, 'Ada')"), schema).diagnostics,
      [],
    );
    strict.deepStrictEqual(
      resolveStatement(parseStatement("INSERT INTO users SELECT $1 AS id, $2 AS name"), schema).parameters.map(
        ({ index, tsType }) => ({ index, tsType }),
      ),
      [
        { index: 1, tsType: "number" },
        { index: 2, tsType: "string" },
      ],
    );
    strict.ok(codes("INSERT INTO users VALUES (1, 'Ada'), (2)").includes("TSQ214"));
    strict.ok(
      codes("INSERT INTO users SELECT 1 AS a, 2 AS b, 3 AS c, 4 AS d, 5 AS e, 6 AS f, 7 AS g").includes("TSQ214"),
    );
    const selection = resolveStatement(parseStatement("INSERT INTO users (id, name) SELECT id FROM users"), schema);
    strict.ok(selection.diagnostics.some((diagnostic) => diagnostic.code === "TSQ214"));
    strict.ok(codes("INSERT INTO users (missing) VALUES (1)").includes("TSQ101"));
    const update = resolveStatement(
      parseStatement(`
      UPDATE users u SET missing = 1, age = a.id
      FROM accounts a LEFT JOIN users other ON other.id = a.id
      WHERE u.id = a.id RETURNING other.name
    `),
      schema,
    );
    strict.ok(update.diagnostics.some((diagnostic) => diagnostic.code === "TSQ101"));
    strict.strictEqual(update.columns[0]?.nullable, true);
    const deletion = resolveStatement(
      parseStatement("DELETE FROM users u USING accounts a WHERE u.id = a.id RETURNING a.label"),
      schema,
    );
    strict.strictEqual(deletion.columns[0]?.nullable, true);
    const updateList = resolveStatement(
      parseStatement("UPDATE users u SET name = a.label FROM accounts a, users other WHERE other.id = a.id"),
      schema,
    );
    strict.deepStrictEqual(updateList.diagnostics, []);
    const deleteJoin = resolveStatement(
      parseStatement(
        "DELETE FROM users u USING accounts a LEFT JOIN users other ON other.id = a.id WHERE u.id = a.id RETURNING other.name",
      ),
      schema,
    );
    strict.deepStrictEqual(deleteJoin.diagnostics, []);
    strict.strictEqual(deleteJoin.columns[0]?.nullable, true);
    strict.deepStrictEqual(
      resolveStatement(parseStatement("UPDATE users SET name = 'Ada' WHERE CURRENT OF active_users"), schema)
        .diagnostics,
      [],
    );
    strict.deepStrictEqual(
      resolveStatement(parseStatement("DELETE FROM users WHERE CURRENT OF active_users"), schema).diagnostics,
      [],
    );
  });

  await it("propagates and validates data-modification source types", () => {
    const insert = resolveStatement(parseStatement("INSERT INTO users (id, name) SELECT $1 AS id, $2 AS name"), schema);
    strict.deepStrictEqual(insert.diagnostics, []);
    strict.deepStrictEqual(
      insert.parameters.map(({ index, tsType }) => ({ index, tsType })),
      [
        { index: 1, tsType: "number" },
        { index: 2, tsType: "string" },
      ],
    );

    const rowAssignment = resolveStatement(
      parseStatement("UPDATE users SET (id, name) = (SELECT $1 AS id, $2 AS name)"),
      schema,
    );
    strict.deepStrictEqual(rowAssignment.diagnostics, []);
    strict.deepStrictEqual(
      rowAssignment.parameters.map(({ index, tsType }) => ({ index, tsType })),
      [
        { index: 1, tsType: "number" },
        { index: 2, tsType: "string" },
      ],
    );

    strict.ok(codes("INSERT INTO users (id) SELECT active FROM users").includes("TSQ229"));
    strict.ok(codes("UPDATE users SET age = active").includes("TSQ229"));
    strict.ok(codes("UPDATE users SET (id, active) = (SELECT name, age FROM users LIMIT 1)").includes("TSQ229"));
    strict.ok(codes("UPDATE users SET age = 1, age = 2").includes("TSQ227"));
  });

  await it("validates star expansion, aliases, USING, CTEs, and lateral scopes", () => {
    strict.ok(codes("SELECT *").includes("TSQ103"));
    strict.ok(codes("SELECT missing.* FROM users").includes("TSQ103"));
    strict.ok(codes("SELECT * FROM users u JOIN accounts a USING (name)").includes("TSQ215"));
    strict.ok(codes("SELECT * FROM users u JOIN accounts u ON true").includes("TSQ108"));
    const qualified = resolveSelect(parseSelect("SELECT u.* FROM users u"), schema);
    strict.strictEqual(qualified.columns.length, 6);
    const lateral = resolveSelect(
      parseSelect("SELECT derived.id FROM users u CROSS JOIN LATERAL (SELECT u.id) derived"),
      schema,
    );
    strict.deepStrictEqual(lateral.diagnostics, []);
    const postgres18 = {
      ...schema,
      server: postgresServerEvidence("18.6", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    strict.deepStrictEqual(
      resolveSelect(parseSelect("SELECT id FROM (SELECT id FROM users)"), postgres18).diagnostics,
      [],
    );
    strict.strictEqual(
      resolveSelect(parseSelect("SELECT renamed FROM (SELECT id FROM users) AS derived(renamed)"), postgres18)
        .columns[0]?.name,
      "renamed",
    );
    strict.ok(
      resolveSelect(
        parseSelect("SELECT renamed FROM (SELECT id, name FROM users) derived(renamed)"),
        postgres18,
      ).diagnostics.some(({ code }) => code === "TSQ213"),
    );
    const postgres15 = {
      ...postgres18,
      server: postgresServerEvidence("15.19", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    strict.ok(
      resolveSelect(parseSelect("SELECT id FROM (SELECT id FROM users)"), postgres15).diagnostics.some(
        ({ code }) => code === "TSQ403",
      ),
    );
    const nonLateral = resolveSelect(
      parseSelect("SELECT derived.id FROM users u CROSS JOIN (SELECT u.id) derived"),
      schema,
    );
    strict.ok(nonLateral.diagnostics.some((diagnostic) => diagnostic.code === "TSQ103"));
  });

  await it("resolves grouping sets and ordered and hypothetical aggregate families", () => {
    const result = resolveSelect(
      parseSelect(`
        SELECT name,
               COUNT(*) AS total,
               GROUPING(name) AS grouping_mask,
               MODE() WITHIN GROUP (ORDER BY age) AS modal_age,
               RANK(42) WITHIN GROUP (ORDER BY age) AS hypothetical_rank,
               ARRAY_AGG(name ORDER BY id DESC) FILTER (WHERE active) AS ordered_names
        FROM users
        GROUP BY GROUPING SETS ((name), ROLLUP(age), CUBE(active), ())
        HAVING COUNT(*) > 0
      `),
      schema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, tsType, nullable }) => ({ name, tsType, nullable })),
      [
        { name: "name", tsType: "string", nullable: true },
        { name: "total", tsType: "bigint", nullable: false },
        { name: "grouping_mask", tsType: "number", nullable: false },
        { name: "modal_age", tsType: "number", nullable: true },
        { name: "hypothetical_rank", tsType: "bigint", nullable: false },
        { name: "ordered_names", tsType: "readonly (string)[]", nullable: true },
      ],
    );

    const aliases = resolveSelect(
      parseSelect(`
        SELECT active AS enabled, COUNT(*) AS total
        FROM users
        GROUP BY DISTINCT enabled
        ORDER BY total
      `),
      schema,
    );
    strict.deepStrictEqual(aliases.diagnostics, []);

    for (const invalid of [
      "SELECT name, COUNT(*) AS total FROM users GROUP BY age",
      "SELECT id FROM users WHERE COUNT(*) > 0",
      "SELECT id FROM users GROUP BY SUM(age)",
      "SELECT id FROM users GROUP BY id HAVING ROW_NUMBER() OVER () > 0",
      "SELECT id, COUNT(*) FROM users GROUP BY id FOR UPDATE",
    ]) {
      strict.ok(codes(invalid).includes("TSQ228"));
    }
  });

  await it("resolves inherited windows and all PostgreSQL frame shapes", () => {
    const result = resolveSelect(
      parseSelect(`
        SELECT ROW_NUMBER() OVER ranked AS row_number,
               LAG(name) OVER (
                 PARTITION BY active ORDER BY id
                 ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE CURRENT ROW
               ) AS previous_name,
               CUME_DIST() OVER (
                 ORDER BY id RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE NO OTHERS
               ) AS distribution
        FROM users
        WINDOW base AS (PARTITION BY active),
               ranked AS (base ORDER BY id GROUPS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE TIES)
      `),
      schema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, tsType, nullable }) => ({ name, tsType, nullable })),
      [
        { name: "row_number", tsType: "bigint", nullable: false },
        { name: "previous_name", tsType: "string", nullable: true },
        { name: "distribution", tsType: "number", nullable: false },
      ],
    );

    for (const invalid of [
      "SELECT ROW_NUMBER() OVER missing AS value FROM users",
      "SELECT ROW_NUMBER() OVER child AS value FROM users WINDOW base AS (PARTITION BY active), child AS (base PARTITION BY id)",
      "SELECT ROW_NUMBER() OVER (ORDER BY id ROWS UNBOUNDED FOLLOWING) AS value FROM users",
      "SELECT ROW_NUMBER() OVER (RANGE 1 PRECEDING) AS value FROM users",
    ]) {
      strict.ok(codes(invalid).includes("TSQ222"));
    }
    for (const invalid of [
      "SELECT ROW_NUMBER() AS value FROM users",
      "SELECT ROW_NUMBER() FILTER (WHERE active) OVER () AS value FROM users",
      "SELECT SUM(DISTINCT age) OVER () AS value FROM users",
      "SELECT GREATEST(id ORDER BY age) AS value FROM users",
    ]) {
      strict.ok(codes(invalid).includes("TSQ223"));
    }
    strict.ok(codes("SELECT SUM(age) WITHIN GROUP (ORDER BY id) AS value FROM users").includes("TSQ227"));
  });

  await it("validates DISTINCT ON ordering and PostgreSQL pagination variants", () => {
    const paginated = resolveSelect(
      parseSelect("SELECT id FROM users ORDER BY id USING > OFFSET $1 ROWS FETCH NEXT $2 ROWS WITH TIES"),
      schema,
    );
    strict.deepStrictEqual(paginated.diagnostics, []);
    strict.deepStrictEqual(
      paginated.parameters.map(({ index, tsType }) => ({ index, tsType })),
      [
        { index: 1, tsType: "number" },
        { index: 2, tsType: "number" },
      ],
    );
    strict.deepStrictEqual(resolveSelect(parseSelect("SELECT id FROM users LIMIT ALL"), schema).diagnostics, []);
    strict.ok(codes("SELECT DISTINCT ON (name) id, name FROM users ORDER BY id, name").includes("TSQ228"));
    strict.deepStrictEqual(
      resolveSelect(parseSelect("SELECT DISTINCT ON (name, id) id, name FROM users ORDER BY id, name"), schema)
        .diagnostics,
      [],
    );
  });

  await it("resolves implicit-lateral table functions, ROWS FROM, ordinality, records, and sampling", () => {
    const series = resolveSelect(
      parseSelect(`
        SELECT series.value, series.ordinality
        FROM users u
        CROSS JOIN generate_series(u.id, u.id + 1) WITH ORDINALITY AS series(value, ordinality)
      `),
      schema,
    );
    strict.deepStrictEqual(series.diagnostics, []);
    strict.deepStrictEqual(
      series.columns.map(({ name, tsType, nullable }) => ({ name, tsType, nullable })),
      [
        { name: "value", tsType: "number", nullable: false },
        { name: "ordinality", tsType: "bigint", nullable: false },
      ],
    );

    const rowsFrom = resolveSelect(
      parseSelect(`
        SELECT expanded.score, expanded.sequence, expanded.ordinality
        FROM users u
        CROSS JOIN ROWS FROM (unnest(u.scores), generate_series(1, 2))
          WITH ORDINALITY AS expanded(score, sequence, ordinality)
      `),
      schema,
    );
    strict.deepStrictEqual(rowsFrom.diagnostics, []);
    strict.deepStrictEqual(
      rowsFrom.columns.map(({ name, tsType, nullable }) => ({ name, tsType, nullable })),
      [
        { name: "score", tsType: "number", nullable: true },
        { name: "sequence", tsType: "number", nullable: true },
        { name: "ordinality", tsType: "bigint", nullable: false },
      ],
    );

    const record = resolveSelect(
      parseSelect(`
        SELECT records.id, records.label
        FROM jsonb_to_recordset('[]'::jsonb) AS records(id integer, label text)
      `),
      schema,
    );
    strict.deepStrictEqual(record.diagnostics, []);
    strict.deepStrictEqual(
      record.columns.map(({ tsType }) => tsType),
      ["number", "string"],
    );

    const sampled = resolveSelect(parseSelect("SELECT id FROM users TABLESAMPLE SYSTEM($1) REPEATABLE($2)"), schema);
    strict.deepStrictEqual(sampled.diagnostics, []);
    strict.deepStrictEqual(
      sampled.parameters.map(({ index, tsType }) => ({ index, tsType })),
      [
        { index: 1, tsType: "string" },
        { index: 2, tsType: "number" },
      ],
    );
    strict.ok(
      codes(
        "SELECT series.value FROM users u RIGHT JOIN LATERAL generate_series(u.id, u.id) AS series(value) ON true",
      ).includes("TSQ103"),
    );
    strict.ok(codes("SELECT id FROM users TABLESAMPLE SYSTEM() REPEATABLE(NULL)").includes("TSQ227"));
  });

  await it("covers PostgreSQL table-function result families and invalid declarations", () => {
    const variants = resolveSelect(
      parseSelect(`
        SELECT object.key, object.value,
               text_object.value AS text_value,
               json_item.value AS json_value,
               text_item.value AS item_text,
               subscript.value AS item_index,
               label.value AS label_value
        FROM users u
        CROSS JOIN jsonb_each(u.payload) AS object
        CROSS JOIN jsonb_each_text(u.payload) AS text_object
        CROSS JOIN jsonb_array_elements(u.payload) AS json_item
        CROSS JOIN jsonb_array_elements_text(u.payload) AS text_item
        CROSS JOIN generate_subscripts(u.scores, 1) AS subscript(value)
        CROSS JOIN one_arg(u.name) AS label(value)
      `),
      schema,
    );
    strict.deepStrictEqual(variants.diagnostics, []);
    strict.deepStrictEqual(
      variants.columns.map(({ tsType }) => tsType),
      ["string", "unknown", "string", "unknown", "string", "number", "string"],
    );

    strict.ok(codes("SELECT 1 AS value FROM jsonb_to_recordset('[]'::jsonb)").includes("TSQ213"));
    strict.ok(codes("SELECT value FROM generate_series(1, 2) AS series(value, extra)").includes("TSQ213"));
    strict.ok(
      codes("SELECT value FROM jsonb_to_recordset('[]'::jsonb) WITH ORDINALITY AS records(value integer)").includes(
        "TSQ227",
      ),
    );
    strict.strictEqual(
      resolveSelect(parseSelect("SELECT mystery.value FROM mystery_rows() AS mystery(value)"), schema).diagnostics[0]
        ?.code,
      "TSQ202",
    );
  });

  await it("covers every expression result family and nullability path", () => {
    const result = resolveSelect(
      parseSelect(`
      SELECT
        DEFAULT AS default_value,
        ARRAY[] AS empty_array,
        ARRAY[1, 'x'] AS mixed_array,
        ROW(id, age) AS tuple_value,
        payload->'item' AS json_value,
        payload#>'{item}' AS json_path,
        payload->>'item' AS text_value,
        payload#>>'{item}' AS text_path,
        name || '!' AS greeting,
        scores || ARRAY[1] AS all_scores,
        age + 1.5 AS numeric_value,
        $1 + 1 AS unknown_value,
        age IS NULL AS known_boolean,
        age BETWEEN 1 AND NULL AS maybe_boolean,
        age IN (1, NULL) AS maybe_in,
        age IN (SELECT id, age FROM users) AS invalid_in,
        (SELECT id, name FROM users) AS invalid_scalar,
        CASE id WHEN 1 THEN name ELSE NULL END AS case_value
      FROM users
    `),
      schema,
    );
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ216"));
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ217"));
    strict.strictEqual(result.columns.find((column) => column.name === "known_boolean")?.nullable, false);
    strict.strictEqual(result.columns.find((column) => column.name === "maybe_boolean")?.nullable, true);
    strict.strictEqual(result.columns.find((column) => column.name === "empty_array")?.tsType, "readonly (unknown)[]");
    strict.strictEqual(
      result.columns.find((column) => column.name === "tuple_value")?.tsType,
      "readonly [number, number | null]",
    );
  });

  await it("covers built-in aggregates and function overload selection", () => {
    const result = resolveSelect(
      parseSelect(`
      SELECT
        COALESCE(NULL, name) AS coalesced,
        COALESCE($1, name) AS uncertain,
        NULLIF(name, 'x') AS nullified,
        MIN(age) AS minimum, MAX(age) AS maximum,
        GREATEST(id, age) AS greatest, LEAST(id, age) AS least,
        SUM(age) AS sum_value, AVG() AS average,
        BOOL_AND(active) AS all_active, BOOL_OR(active) AS any_active, EVERY(active) AS every_active,
        STRING_AGG(name, ',') AS names,
        JSON_AGG(id) AS json_values, JSONB_AGG(id) AS jsonb_values,
        JSON_OBJECT_AGG(id, name) AS json_object, JSONB_OBJECT_AGG(id, name) AS jsonb_object,
        ARRAY_AGG(age) AS ages, ARRAY_AGG() AS unknown_array,
        public.label_for(id) AS label,
        one_arg($1) AS fallback,
        choose(name) AS ambiguous
      FROM users
    `),
      schema,
    );
    strict.strictEqual(result.columns.find((column) => column.name === "coalesced")?.databaseType, "text");
    strict.strictEqual(result.columns.find((column) => column.name === "jsonb_values")?.databaseType, "jsonb");
    strict.strictEqual(result.columns.find((column) => column.name === "ages")?.tsType, "readonly (number | null)[]");
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ204"));
  });

  await it("keeps suggestions and quoted identifiers deterministic", () => {
    const noSuggestion = resolveSelect(parseSelect("SELECT zzzzzzz FROM users"), schema);
    strict.strictEqual(noSuggestion.diagnostics[0]?.suggestion, undefined);
    const quotedSchema = {
      ...schema,
      tables: {
        "Special.CaseTable": {
          schema: "Special",
          name: "CaseTable",
          columns: { Value: { name: "Value", databaseType: "text", tsType: "string", nullable: false } },
        },
      },
    } as const satisfies SchemaSnapshot;
    const quoted = resolveSelect(parseSelect('SELECT t."Value" FROM "Special"."CaseTable" AS t'), quotedSchema);
    strict.deepStrictEqual(quoted.diagnostics, []);
  });
});
