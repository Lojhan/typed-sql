import { describe, it, strict } from "poku";
import { rowTypeLiteral } from "../../core/src/index.js";
import { type SchemaSnapshot, upgradeSchemaSnapshotV1 } from "../../schema/src/index.js";
import { postgresServerEvidence } from "../src/capabilities.js";
import { fingerprintPostgresExpressionSql } from "../src/expression-evidence.js";
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
      },
    },
    ages: {
      name: "ages",
      columns: {
        user_id: { name: "user_id", databaseType: "integer", tsType: "number", nullable: false },
        label: { name: "label", databaseType: "text", tsType: "string", nullable: false },
      },
    },
  },
} as const satisfies SchemaSnapshot;

const v2Schema = (() => {
  const upgraded = upgradeSchemaSnapshotV1(schema);
  const users = upgraded.relations.users!;
  return {
    ...upgraded,
    relations: {
      ...upgraded.relations,
      users: {
        ...users,
        columns: {
          ...users.columns,
          id: { ...users.columns.id!, default: "present", identity: "always", insertable: false, updatable: false },
          name: { ...users.columns.name!, default: "none", identity: "none", insertable: true, updatable: true },
          age: { ...users.columns.age!, default: "none", identity: "none", insertable: true, updatable: false },
        },
      },
    },
  } as const satisfies SchemaSnapshot;
})();

await describe("query resolver", async () => {
  await it("infers the acceptance row and cast policy", async () => {
    const statement = parseSelect(`
      SELECT user.id, user.name, user.age::BIGINT AS age
      FROM users AS user
      LEFT JOIN ages AS age ON user.id = age.user_id
    `);
    const result = resolveSelect(statement, schema);
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(rowTypeLiteral(result.columns), '{ "id": number; "name": string; "age": bigint | null; }');
  });

  await it("makes the right side of a LEFT JOIN nullable", async () => {
    const result = resolveSelect(
      parseSelect("SELECT a.label FROM users u LEFT JOIN ages a ON u.id = a.user_id"),
      schema,
    );
    strict.strictEqual(result.columns[0]?.nullable, true);
  });

  await it("reports unknown, ambiguous, and duplicate columns", async () => {
    const unknown = resolveSelect(parseSelect("SELECT u.missing FROM users u"), schema);
    strict.strictEqual(unknown.diagnostics[0]?.code, "TSQ101");

    const ambiguous = resolveSelect(parseSelect("SELECT id FROM users u JOIN users other ON true"), schema);
    strict.strictEqual(ambiguous.diagnostics[0]?.code, "TSQ102");

    const duplicate = resolveSelect(parseSelect("SELECT u.id, other.id FROM users u JOIN users other ON true"), schema);
    strict.strictEqual(duplicate.diagnostics.at(-1)?.code, "TSQ105");
  });

  await it("honors a configured bigint mapping", async () => {
    const result = resolveSelect(parseSelect("SELECT id::BIGINT AS id FROM users"), schema, {
      typePolicy: {
        bigint: "string",
        numeric: "string",
        date: "Date",
        json: "unknown",
        enums: "string-union",
        unknown: "unknown",
      },
    });
    strict.strictEqual(result.columns[0]?.tsType, "string");
  });

  await it("requires schema qualification when table names collide", async () => {
    const multiSchema = {
      ...schema,
      tables: {
        "public.users": { ...schema.tables.users, schema: "public" },
        "audit.users": { ...schema.tables.users, schema: "audit" },
      },
    } as const satisfies SchemaSnapshot;
    const ambiguous = resolveSelect(parseSelect("SELECT id FROM users"), multiSchema);
    strict.strictEqual(ambiguous.diagnostics[0]?.code, "TSQ107");
    const qualified = resolveSelect(parseSelect("SELECT id FROM public.users"), multiSchema);
    strict.deepStrictEqual(qualified.diagnostics, []);
    strict.strictEqual(qualified.columns[0]?.tsType, "number");
  });

  await it("fails safely for unknown relations, aliases, tables, casts, and output names", async () => {
    const unknownTable = resolveSelect(parseSelect("SELECT id FROM usres"), schema);
    strict.strictEqual(unknownTable.diagnostics[0]?.code, "TSQ100");
    strict.ok(unknownTable.diagnostics[0]?.suggestion?.includes("users"));

    const unknownAlias = resolveSelect(parseSelect("SELECT usr.id FROM users u"), schema);
    strict.strictEqual(unknownAlias.diagnostics[0]?.code, "TSQ103");
    const invalidCast = resolveSelect(parseSelect("SELECT id::made_up AS value FROM users"), schema);
    strict.strictEqual(invalidCast.diagnostics[0]?.code, "TSQ106");
    strict.deepStrictEqual(resolveSelect(parseSelect("SELECT true::integer AS value"), schema).diagnostics, []);
    strict.ok(
      resolveSelect(parseSelect("SELECT true::date AS value"), schema).diagnostics.some(
        ({ code }) => code === "TSQ230",
      ),
    );

    const unnamed = resolveSelect(parseSelect("SELECT id + 1 FROM users"), schema);
    strict.strictEqual(unnamed.diagnostics[0]?.code, "TSQ104");
    const permissive = resolveSelect(parseSelect("SELECT id + 1 FROM users"), schema, { strictExpressions: false });
    strict.deepStrictEqual(permissive.diagnostics, []);
    strict.deepStrictEqual(permissive.columns, []);
  });

  await it("resolves literals, parameters, unary/binary expressions, and CASE nullability", async () => {
    const result = resolveSelect(
      parseSelect(`
      SELECT 'ok' AS text_value,
             NULL AS missing,
             $1 AS input,
             NOT (age IS NULL) AS has_age,
             -id AS negative_id,
             ~id AS inverted_id,
             id & 3 AS masked_id,
             id + 1 AS next_id,
             id + 'x' AS mixed,
             -'x' AS invalid_negative,
             NOT id AS invalid_not,
             '2026-01-02'::date - '2026-01-01'::date AS elapsed_days,
             '1 day'::interval * 2 AS doubled_interval,
             '192.168.1.0/24'::inet << '192.168.1.4'::inet AS subnet_contains,
             '[1,5)'::int4range @> 3 AS range_contains,
             'cat'::tsvector @@ 'cat'::tsquery AS text_matches,
             'cat'::tsquery && 'dog'::tsquery AS combined_query,
             '{}'::jsonb @? '$.a'::jsonpath AS path_matches,
             '{}'::jsonb #- ARRAY['private'] AS redacted,
             !! ('cat'::tsquery) AS negated_query,
             '(2,2),(0,0)'::box <-> '(3,3)'::point AS shape_distance,
             @@ ('(2,2),(0,0)'::box) AS shape_center,
             # ('((0,0),(1,1))'::path) AS shape_points,
             |/ (25::double precision) AS square_root,
             '101'::varbit << 1 AS shifted_bits,
             '\\x01'::bytea || '\\x02'::bytea AS combined_bytes,
             '0/10'::pg_lsn - '0/8'::pg_lsn AS lsn_distance,
             '$2.00'::money * 2 AS scaled_money,
             CASE WHEN age IS NULL THEN 0 END AS maybe_age,
             CASE WHEN age IS NULL THEN 0 ELSE age END AS safe_age
      FROM users
    `),
      schema,
    );
    strict.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["TSQ203", "TSQ203", "TSQ203"],
    );
    strict.deepStrictEqual(
      result.columns.map(({ name, tsType, nullable }) => ({ name, tsType, nullable })),
      [
        { name: "text_value", tsType: "string", nullable: false },
        { name: "missing", tsType: "unknown", nullable: true },
        { name: "input", tsType: "unknown", nullable: true },
        { name: "has_age", tsType: "boolean", nullable: false },
        { name: "negative_id", tsType: "number", nullable: false },
        { name: "inverted_id", tsType: "number", nullable: false },
        { name: "masked_id", tsType: "number", nullable: false },
        { name: "next_id", tsType: "number", nullable: false },
        { name: "mixed", tsType: "unknown", nullable: true },
        { name: "invalid_negative", tsType: "unknown", nullable: true },
        { name: "invalid_not", tsType: "unknown", nullable: true },
        { name: "elapsed_days", tsType: "number", nullable: false },
        { name: "doubled_interval", tsType: "string", nullable: false },
        { name: "subnet_contains", tsType: "boolean", nullable: false },
        { name: "range_contains", tsType: "boolean", nullable: false },
        { name: "text_matches", tsType: "boolean", nullable: false },
        { name: "combined_query", tsType: "string", nullable: false },
        { name: "path_matches", tsType: "boolean", nullable: false },
        { name: "redacted", tsType: "unknown", nullable: false },
        { name: "negated_query", tsType: "string", nullable: false },
        { name: "shape_distance", tsType: "number", nullable: false },
        { name: "shape_center", tsType: "string", nullable: false },
        { name: "shape_points", tsType: "number", nullable: false },
        { name: "square_root", tsType: "number", nullable: false },
        { name: "shifted_bits", tsType: "string", nullable: false },
        { name: "combined_bytes", tsType: "Uint8Array", nullable: false },
        { name: "lsn_distance", tsType: "string", nullable: false },
        { name: "scaled_money", tsType: "string", nullable: false },
        { name: "maybe_age", tsType: "number", nullable: true },
        { name: "safe_age", tsType: "number", nullable: true },
      ],
    );
  });

  await it("resolves PostgreSQL interval literal forms through canonical interval typing", () => {
    const result = resolveSelect(
      parseSelect(`
        SELECT INTERVAL '1 day' AS plain,
               INTERVAL (3) '1.2345 seconds' AS precise,
               INTERVAL '1-2' YEAR TO MONTH AS year_month,
               INTERVAL '1 day 2:03:04.5678' DAY TO SECOND (3) * 2 AS doubled,
               CAST('2:03:04.567' AS INTERVAL HOUR TO SECOND(2)) AS casted
      `),
      schema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, tsType, nullable, databaseType }) => ({ name, tsType, nullable, databaseType })),
      ["plain", "precise", "year_month", "doubled", "casted"].map((name) => ({
        name,
        tsType: "string",
        nullable: false,
        databaseType: "interval",
      })),
    );
  });

  await it("resolves PostgreSQL JSON-path typed literals and routine signatures", () => {
    const result = resolveSelect(
      parseSelect(`
        SELECT jsonb_path_exists(JSONB '{"a":[1,2]}', JSONPATH '$.a[*] ? (@ > 1)') AS exists_value,
               jsonb_path_match(JSONB '{"a":1}', JSONPATH '$.a == 1') AS match_value,
               jsonb_path_query_array(JSONB '{"a":[1,2]}', JSONPATH '$.a[*]') AS array_value,
               jsonb_path_query_first(JSONB '{"a":[1,2]}', JSONPATH '$.a[*]') AS first_value,
               jsonb_path_query(JSONB '{"a":[1,2]}', JSONPATH '$.a[*]') AS set_value,
               jsonb_path_exists(path => JSONPATH '$.a', target => JSONB '{"a":1}', silent => true) AS named_value,
               jsonb_path_exists($1, $2, $3, $4) AS parameterized
      `),
      schema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, databaseType, nullable }) => ({ name, databaseType, nullable })),
      [
        { name: "exists_value", databaseType: "boolean", nullable: false },
        { name: "match_value", databaseType: "boolean", nullable: true },
        { name: "array_value", databaseType: "jsonb", nullable: false },
        { name: "first_value", databaseType: "jsonb", nullable: true },
        { name: "set_value", databaseType: "jsonb", nullable: false },
        { name: "named_value", databaseType: "boolean", nullable: false },
        { name: "parameterized", databaseType: "boolean", nullable: true },
      ],
    );
    strict.deepStrictEqual(
      result.parameters.map(({ index, databaseType }) => ({ index, databaseType })),
      [
        { index: 1, databaseType: "jsonb" },
        { index: 2, databaseType: "jsonpath" },
        { index: 3, databaseType: "jsonb" },
        { index: 4, databaseType: "boolean" },
      ],
    );

    for (const source of [
      "SELECT jsonb_path_exists(1, JSONPATH '$') AS invalid",
      "SELECT jsonb_path_exists(JSONB '{}') AS invalid",
      "SELECT jsonb_path_exists(target => JSONB '{}', target => JSONB '{}') AS invalid",
    ]) {
      strict.ok(resolveSelect(parseSelect(source), schema).diagnostics.some(({ code }) => code === "TSQ202"));
    }

    const table = resolveSelect(
      parseSelect(`
        SELECT paths.jsonb_path_query AS value
        FROM jsonb_path_query(JSONB '{"a":[1,2]}', JSONPATH '$.a[*]') AS paths
      `),
      schema,
    );
    strict.deepStrictEqual(table.diagnostics, []);
    strict.strictEqual(table.columns[0]?.databaseType, "jsonb");
    strict.strictEqual(table.columns[0]?.nullable, false);
    const invalidTable = resolveSelect(parseSelect("SELECT * FROM jsonb_path_query(1, JSONPATH '$') AS paths"), schema);
    strict.ok(invalidTable.diagnostics.some(({ code }) => code === "TSQ202"));
  });

  await it("resolves and version-gates PostgreSQL 17 JSON_EXISTS", () => {
    const postgres18 = {
      ...upgradeSchemaSnapshotV1(schema),
      server: postgresServerEvidence("18.6", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect(`
        SELECT JSON_EXISTS(
                 JSONB '{"items":[1,2]}',
                 JSONPATH 'strict $.items[*] ? (@ > $minimum)'
                 PASSING 1 AS minimum FALSE ON ERROR
               ) AS exact_match,
               JSON_EXISTS($1, $2 PASSING $3 AS variable UNKNOWN ON ERROR) AS maybe_match,
               JSON_EXISTS(NULL, JSONPATH '$') AS null_input,
               JSON_EXISTS('{}'::text FORMAT JSON, '$'::text TRUE ON ERROR)
      `),
      postgres18,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, databaseType, tsType, nullable }) => ({ name, databaseType, tsType, nullable })),
      [
        { name: "exact_match", databaseType: "boolean", tsType: "boolean", nullable: false },
        { name: "maybe_match", databaseType: "boolean", tsType: "boolean", nullable: true },
        { name: "null_input", databaseType: "boolean", tsType: "boolean", nullable: true },
        { name: "json_exists", databaseType: "boolean", tsType: "boolean", nullable: false },
      ],
    );
    strict.deepStrictEqual(
      result.parameters.map(({ index, databaseType, tsType }) => ({ index, databaseType, tsType })),
      [
        { index: 1, databaseType: "text", tsType: "string" },
        { index: 2, databaseType: "jsonpath", tsType: "string" },
        { index: 3, databaseType: "text", tsType: "string" },
      ],
    );

    for (const invalid of [
      "SELECT JSON_EXISTS(1, '$') AS value",
      "SELECT JSON_EXISTS('{}', 1) AS value",
      "SELECT JSON_EXISTS('{}', '$' PASSING 1 FORMAT JSON AS value) AS value",
      "SELECT JSON_EXISTS($1::bytea FORMAT JSON ENCODING UTF16, '$') AS value",
      "SELECT JSON_EXISTS($1 FORMAT JSON ENCODING UTF8, '$') AS value",
    ]) {
      const invalidResult = resolveSelect(parseSelect(invalid), postgres18);
      strict.ok(
        invalidResult.diagnostics.some(({ code }) => code === "TSQ203"),
        invalid,
      );
      strict.strictEqual(invalidResult.columns[0]?.tsType, "unknown", invalid);
    }

    const postgres16 = {
      ...postgres18,
      server: postgresServerEvidence("16.10", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    strict.ok(
      resolveSelect(parseSelect("SELECT JSON_EXISTS('{}', '$')"), postgres16).diagnostics.some(
        ({ code }) => code === "TSQ403",
      ),
    );
    strict.ok(
      resolveSelect(parseSelect("SELECT JSON_EXISTS('{}', '$')"), upgradeSchemaSnapshotV1(schema)).diagnostics.some(
        ({ code }) => code === "TSQ402",
      ),
    );
  });

  await it("resolves and version-gates PostgreSQL 17 JSON_QUERY", () => {
    const postgres18 = {
      ...upgradeSchemaSnapshotV1(schema),
      server: postgresServerEvidence("18.6", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect(`
        SELECT JSON_QUERY(JSONB '{"items":[1,2]}', JSONPATH '$.items') AS document,
               JSON_QUERY(
                 JSONB '{"value":4}', JSONPATH '$.value'
                 RETURNING integer OMIT QUOTES ERROR ON EMPTY ERROR ON ERROR
               ) AS exact_number,
               JSON_QUERY(
                 JSONB '{}', JSONPATH '$.missing'
                 RETURNING text EMPTY ARRAY ON EMPTY EMPTY OBJECT ON ERROR
               ) AS fallback_text,
               JSON_QUERY($1, $2 PASSING $3 AS variable ERROR ON EMPTY ERROR ON ERROR) AS parameterized,
               JSON_QUERY(JSONB '{}', JSONPATH '$.missing' RETURNING integer DEFAULT NULL ON EMPTY)
      `),
      postgres18,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, databaseType, tsType, nullable }) => ({ name, databaseType, tsType, nullable })),
      [
        { name: "document", databaseType: "jsonb", tsType: "unknown", nullable: true },
        { name: "exact_number", databaseType: "integer", tsType: "number", nullable: false },
        { name: "fallback_text", databaseType: "text", tsType: "string", nullable: false },
        { name: "parameterized", databaseType: "jsonb", tsType: "unknown", nullable: true },
        { name: "json_query", databaseType: "integer", tsType: "number", nullable: true },
      ],
    );
    strict.deepStrictEqual(
      result.parameters.map(({ index, databaseType, tsType }) => ({ index, databaseType, tsType })),
      [
        { index: 1, databaseType: "text", tsType: "string" },
        { index: 2, databaseType: "jsonpath", tsType: "string" },
        { index: 3, databaseType: "text", tsType: "string" },
      ],
    );

    for (const invalid of [
      "SELECT JSON_QUERY('{}', '$' RETURNING missing_type) AS value",
      "SELECT JSON_QUERY('{}', '$' RETURNING integer FORMAT JSON) AS value",
      "SELECT JSON_QUERY('{}', '$' RETURNING text FORMAT JSON ENCODING UTF8) AS value",
      "SELECT JSON_QUERY('{}', '$' RETURNING bytea FORMAT JSON ENCODING UTF16) AS value",
      "SELECT JSON_QUERY('{}', '$' WITH WRAPPER OMIT QUOTES) AS value",
      "SELECT JSON_QUERY('{}', '$' RETURNING integer DEFAULT $1 ON EMPTY) AS value",
      "SELECT JSON_QUERY('{}', '$' RETURNING integer DEFAULT name ON EMPTY) AS value FROM users",
      "SELECT JSON_QUERY(1, '$') AS value",
      "SELECT JSON_QUERY('{}', 1) AS value",
    ]) {
      const invalidResult = resolveSelect(parseSelect(invalid), postgres18);
      strict.ok(
        invalidResult.diagnostics.some(({ code }) => code === "TSQ106" || code === "TSQ203"),
        invalid,
      );
      strict.strictEqual(invalidResult.columns[0]?.tsType, "unknown", invalid);
    }

    const postgres16 = {
      ...postgres18,
      server: postgresServerEvidence("16.10", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    strict.ok(
      resolveSelect(parseSelect("SELECT JSON_QUERY('{}', '$')"), postgres16).diagnostics.some(
        ({ code }) => code === "TSQ403",
      ),
    );
  });

  await it("resolves and version-gates PostgreSQL 17 JSON_VALUE", () => {
    const postgres18 = {
      ...upgradeSchemaSnapshotV1(schema),
      server: postgresServerEvidence("18.6", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect(`
        SELECT JSON_VALUE(JSONB '{"value":4}', JSONPATH '$.value') AS scalar_text,
               JSON_VALUE(
                 JSONB '{"value":4}', JSONPATH '$.value'
                 RETURNING integer ERROR ON EMPTY ERROR ON ERROR
               ) AS scalar_number,
               JSON_VALUE(
                 JSONB '{}', JSONPATH '$.missing'
                 RETURNING numeric DEFAULT 0 ON EMPTY DEFAULT 1 ON ERROR
               ) AS fallback_number,
               JSON_VALUE($1, $2 PASSING $3 AS variable RETURNING date) AS parameterized,
               JSON_VALUE(JSONB '{"value":null}', JSONPATH '$.value' RETURNING integer ERROR ON EMPTY ERROR ON ERROR)
      `),
      postgres18,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, databaseType, tsType, nullable }) => ({ name, databaseType, tsType, nullable })),
      [
        { name: "scalar_text", databaseType: "text", tsType: "string", nullable: true },
        { name: "scalar_number", databaseType: "integer", tsType: "number", nullable: true },
        { name: "fallback_number", databaseType: "numeric", tsType: "string", nullable: true },
        { name: "parameterized", databaseType: "date", tsType: "Date", nullable: true },
        { name: "json_value", databaseType: "integer", tsType: "number", nullable: true },
      ],
    );
    strict.deepStrictEqual(
      result.parameters.map(({ index, databaseType, tsType }) => ({ index, databaseType, tsType })),
      [
        { index: 1, databaseType: "text", tsType: "string" },
        { index: 2, databaseType: "jsonpath", tsType: "string" },
        { index: 3, databaseType: "text", tsType: "string" },
      ],
    );

    for (const invalid of [
      "SELECT JSON_VALUE('{}', '$' RETURNING missing_type) AS value",
      "SELECT JSON_VALUE('{}', '$' RETURNING text FORMAT JSON) AS value",
      "SELECT JSON_VALUE('{}', '$' EMPTY ARRAY ON EMPTY) AS value",
      "SELECT JSON_VALUE('{}', '$' EMPTY OBJECT ON ERROR) AS value",
      "SELECT JSON_VALUE('{}', '$' RETURNING integer DEFAULT $1 ON EMPTY) AS value",
      "SELECT JSON_VALUE('{}', '$' RETURNING integer DEFAULT name ON EMPTY) AS value FROM users",
      "SELECT JSON_VALUE(1, '$') AS value",
      "SELECT JSON_VALUE('{}', 1) AS value",
    ]) {
      const invalidResult = resolveSelect(parseSelect(invalid), postgres18);
      strict.ok(
        invalidResult.diagnostics.some(({ code }) => code === "TSQ106" || code === "TSQ203"),
        invalid,
      );
      strict.strictEqual(invalidResult.columns[0]?.tsType, "unknown", invalid);
    }

    const postgres16 = {
      ...postgres18,
      server: postgresServerEvidence("16.10", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    strict.ok(
      resolveSelect(parseSelect("SELECT JSON_VALUE('{}', '$')"), postgres16).diagnostics.some(
        ({ code }) => code === "TSQ403",
      ),
    );
  });

  await it("resolves and version-gates PostgreSQL 16 SQL/JSON constructors", () => {
    const postgres18 = {
      ...upgradeSchemaSnapshotV1(schema),
      server: postgresServerEvidence("18.6", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect(`
        SELECT JSON_OBJECT('id' VALUE id, 'age': age ABSENT ON NULL RETURNING jsonb) AS document,
               JSON_ARRAY(id, age NULL ON NULL RETURNING text) AS array_values,
               JSON_ARRAY(SELECT name FROM users RETURNING bytea) AS names,
               JSON_OBJECT() AS empty_object,
               JSON_OBJECT(
                 $1::text VALUE $2::integer,
                 'raw' VALUE $3 FORMAT JSON
                 RETURNING bytea FORMAT JSON ENCODING UTF8
               ) AS parameterized_object,
               JSON_ARRAY($4::date, $5 FORMAT JSON RETURNING jsonb) AS parameterized_array
        FROM users
      `),
      postgres18,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, databaseType, tsType, nullable }) => ({ name, databaseType, tsType, nullable })),
      [
        { name: "document", databaseType: "jsonb", tsType: "unknown", nullable: false },
        { name: "array_values", databaseType: "text", tsType: "string", nullable: false },
        { name: "names", databaseType: "bytea", tsType: "Uint8Array", nullable: false },
        { name: "empty_object", databaseType: "json", tsType: "unknown", nullable: false },
        { name: "parameterized_object", databaseType: "bytea", tsType: "Uint8Array", nullable: false },
        { name: "parameterized_array", databaseType: "jsonb", tsType: "unknown", nullable: false },
      ],
    );
    strict.deepStrictEqual(
      result.parameters.map(({ index, databaseType, tsType }) => ({ index, databaseType, tsType })),
      [
        { index: 1, databaseType: "text", tsType: "string" },
        { index: 2, databaseType: "integer", tsType: "number" },
        { index: 3, databaseType: "text", tsType: "string" },
        { index: 4, databaseType: "date", tsType: "Date" },
        { index: 5, databaseType: "text", tsType: "string" },
      ],
    );

    const unresolved = resolveSelect(parseSelect("SELECT JSON_OBJECT($1 VALUE $2), JSON_ARRAY($3)"), postgres18);
    strict.deepStrictEqual(
      unresolved.columns.map(({ tsType }) => tsType),
      ["unknown", "unknown"],
    );
    strict.deepStrictEqual(
      unresolved.parameters.map(({ index, databaseType, tsType }) => ({ index, databaseType, tsType })),
      [
        { index: 1, databaseType: undefined, tsType: "unknown" },
        { index: 2, databaseType: undefined, tsType: "unknown" },
        { index: 3, databaseType: undefined, tsType: "unknown" },
      ],
    );

    for (const invalid of [
      "SELECT JSON_OBJECT(NULL VALUE 1) AS value",
      "SELECT JSON_OBJECT(JSON '{\"key\":1}' VALUE 1) AS value",
      "SELECT JSON_OBJECT(ROW(1, 2) VALUE 1) AS value",
      "SELECT JSON_OBJECT('key' VALUE 1 RETURNING integer) AS value",
      "SELECT JSON_ARRAY(1 RETURNING missing_type) AS value",
      "SELECT JSON_ARRAY(1 FORMAT JSON) AS value",
      "SELECT JSON_ARRAY(convert_to('{}', 'UTF8') FORMAT JSON ENCODING UTF16) AS value",
      "SELECT JSON_ARRAY(SELECT 1, 2) AS value",
    ]) {
      const invalidResult = resolveSelect(parseSelect(invalid), postgres18);
      strict.ok(
        invalidResult.diagnostics.some(({ code }) => ["TSQ106", "TSQ203", "TSQ216"].includes(code)),
        invalid,
      );
      strict.strictEqual(invalidResult.columns[0]?.tsType, "unknown", invalid);
    }

    const postgres15 = {
      ...postgres18,
      server: postgresServerEvidence("15.14", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    strict.ok(
      resolveSelect(parseSelect("SELECT JSON_ARRAY(1)"), postgres15).diagnostics.some(({ code }) => code === "TSQ403"),
    );
    strict.ok(
      resolveSelect(parseSelect("SELECT JSON_OBJECT('key' VALUE 1)"), upgradeSchemaSnapshotV1(schema)).diagnostics.some(
        ({ code }) => code === "TSQ402",
      ),
    );
  });

  await it("resolves and version-gates PostgreSQL 17 SQL/JSON identity forms", () => {
    const postgres18 = {
      ...upgradeSchemaSnapshotV1(schema),
      server: postgresServerEvidence("18.6", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect(`
        SELECT JSON('{}') AS document,
               JSON(name) AS named_document,
               JSON($2 WITH UNIQUE KEYS) AS parameterized_document,
               JSON_SCALAR(id) AS scalar,
               JSON_SCALAR(age) AS nullable_scalar,
               JSON_SCALAR($3) AS parameterized_scalar,
               JSON_SERIALIZE('{}') AS serialized,
               JSON_SERIALIZE(name RETURNING varchar) AS named_serialized,
               JSON_SERIALIZE(
                 $1::bytea FORMAT JSON ENCODING UTF8
                 RETURNING bytea FORMAT JSON ENCODING UTF8
               ) AS binary_serialized,
               JSON_SERIALIZE($4 FORMAT JSON) AS parameterized_serialized
        FROM users
      `),
      postgres18,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, databaseType, tsType, nullable }) => ({ name, databaseType, tsType, nullable })),
      [
        { name: "document", databaseType: "json", tsType: "unknown", nullable: false },
        { name: "named_document", databaseType: "json", tsType: "unknown", nullable: false },
        { name: "parameterized_document", databaseType: "json", tsType: "unknown", nullable: true },
        { name: "scalar", databaseType: "json", tsType: "unknown", nullable: false },
        { name: "nullable_scalar", databaseType: "json", tsType: "unknown", nullable: true },
        { name: "parameterized_scalar", databaseType: "json", tsType: "unknown", nullable: true },
        { name: "serialized", databaseType: "text", tsType: "string", nullable: false },
        { name: "named_serialized", databaseType: "varchar", tsType: "string", nullable: false },
        { name: "binary_serialized", databaseType: "bytea", tsType: "Uint8Array", nullable: true },
        { name: "parameterized_serialized", databaseType: "text", tsType: "string", nullable: true },
      ],
    );
    strict.deepStrictEqual(
      result.parameters.map(({ index, databaseType, tsType }) => ({ index, databaseType, tsType })),
      [
        { index: 1, databaseType: "bytea", tsType: "Uint8Array" },
        { index: 2, databaseType: "text", tsType: "string" },
        { index: 3, databaseType: "text", tsType: "string" },
        { index: 4, databaseType: "text", tsType: "string" },
      ],
    );

    const composites = resolveSelect(
      parseSelect("SELECT JSON_SCALAR(ARRAY[1, 2]) AS array_value, JSON_SCALAR(ROW(1, true)) AS row_value"),
      postgres18,
    );
    strict.deepStrictEqual(composites.diagnostics, []);
    strict.deepStrictEqual(
      composites.columns.map(({ databaseType, nullable }) => ({ databaseType, nullable })),
      [
        { databaseType: "json", nullable: false },
        { databaseType: "json", nullable: false },
      ],
    );

    for (const invalid of [
      "SELECT JSON(1) AS value",
      "SELECT JSON('{}' FORMAT JSON ENCODING UTF8) AS value",
      "SELECT JSON(convert_to('{}', 'UTF8') FORMAT JSON ENCODING UTF16) AS value",
      "SELECT JSON_SERIALIZE(1) AS value",
      "SELECT JSON_SERIALIZE('{}' RETURNING jsonb) AS value",
      "SELECT JSON_SERIALIZE('{}' RETURNING integer) AS value",
      "SELECT JSON_SERIALIZE('{}' RETURNING missing_type) AS value",
      "SELECT JSON_SERIALIZE('{}' RETURNING text FORMAT JSON ENCODING UTF8) AS value",
    ]) {
      const invalidResult = resolveSelect(parseSelect(invalid), postgres18);
      strict.ok(
        invalidResult.diagnostics.some(({ code }) => ["TSQ106", "TSQ203"].includes(code)),
        invalid,
      );
      strict.strictEqual(invalidResult.columns[0]?.tsType, "unknown", invalid);
    }

    const postgres16 = {
      ...postgres18,
      server: postgresServerEvidence("16.10", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    const legacyCast = resolveSelect(parseSelect("SELECT JSON('{}') AS value"), postgres16);
    strict.deepStrictEqual(legacyCast.diagnostics, []);
    strict.deepStrictEqual(
      legacyCast.columns.map(({ databaseType, nullable }) => ({ databaseType, nullable })),
      [{ databaseType: "json", nullable: false }],
    );
    const unresolvedLegacyCast = resolveSelect(parseSelect("SELECT JSON($1) AS value"), postgres16);
    strict.ok(unresolvedLegacyCast.diagnostics.some(({ code }) => code === "TSQ202"));
    strict.strictEqual(unresolvedLegacyCast.columns[0]?.tsType, "unknown");
    strict.deepStrictEqual(
      unresolvedLegacyCast.parameters.map(({ databaseType, tsType }) => ({ databaseType, tsType })),
      [{ databaseType: undefined, tsType: "unknown" }],
    );
    const invalidLegacyCast = resolveSelect(parseSelect("SELECT JSON(1) AS value"), postgres16);
    strict.ok(invalidLegacyCast.diagnostics.some(({ code }) => code === "TSQ230"));
    strict.strictEqual(invalidLegacyCast.columns[0]?.tsType, "unknown");
    for (const query of [
      "SELECT JSON('{}' WITH UNIQUE KEYS)",
      "SELECT JSON_SCALAR(1)",
      "SELECT JSON_SERIALIZE('{}')",
    ]) {
      strict.ok(resolveSelect(parseSelect(query), postgres16).diagnostics.some(({ code }) => code === "TSQ403"));
    }
    strict.ok(
      resolveSelect(parseSelect("SELECT JSON_SCALAR(1)"), upgradeSchemaSnapshotV1(schema)).diagnostics.some(
        ({ code }) => code === "TSQ402",
      ),
    );
  });

  await it("resolves and version-gates PostgreSQL 17 JSON_TABLE", () => {
    const postgres18 = {
      ...upgradeSchemaSnapshotV1(schema),
      server: postgresServerEvidence("18.6", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect(`
        SELECT row_number, amount, present, present_int, child_number, label
        FROM JSON_TABLE(
          $1,
          '$.items[*]' AS item_path
          PASSING $2 AS threshold
          COLUMNS (
            row_number FOR ORDINALITY,
            amount numeric PATH '$.amount' DEFAULT 0 ON EMPTY ERROR ON ERROR,
            present boolean EXISTS PATH '$.amount' FALSE ON ERROR,
            present_int integer EXISTS PATH '$.amount' UNKNOWN ON ERROR,
            NESTED PATH '$.children[*]' AS child_path COLUMNS (
              child_number FOR ORDINALITY,
              label text PATH '$.label' ERROR ON EMPTY ERROR ON ERROR
            )
          )
          EMPTY ARRAY ON ERROR
        ) AS jt
      `),
      postgres18,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, databaseType, tsType, nullable }) => ({ name, databaseType, tsType, nullable })),
      [
        { name: "row_number", databaseType: "integer", tsType: "number", nullable: false },
        { name: "amount", databaseType: "numeric", tsType: "string", nullable: true },
        { name: "present", databaseType: "boolean", tsType: "boolean", nullable: false },
        { name: "present_int", databaseType: "integer", tsType: "number", nullable: true },
        { name: "child_number", databaseType: "integer", tsType: "number", nullable: true },
        { name: "label", databaseType: "text", tsType: "string", nullable: true },
      ],
    );
    strict.deepStrictEqual(
      result.parameters.map(({ index, databaseType, tsType }) => ({ index, databaseType, tsType })),
      [
        { index: 1, databaseType: "text", tsType: "string" },
        { index: 2, databaseType: "text", tsType: "string" },
      ],
    );

    const lateral = resolveSelect(
      parseSelect(`
        SELECT jt.renamed
        FROM users AS u,
             JSON_TABLE(u.name, '$' COLUMNS(value text PATH '$')) AS jt(renamed)
      `),
      postgres18,
    );
    strict.deepStrictEqual(lateral.diagnostics, []);
    strict.strictEqual(lateral.columns[0]?.name, "renamed");
    const formattedBehavior = resolveSelect(
      parseSelect(`
        SELECT value
        FROM JSON_TABLE(
          '{}', '$'
          PASSING 1 AS duplicate_name, 2 AS duplicate_name
          COLUMNS (value text PATH '$.missing' WITH WRAPPER EMPTY ARRAY ON EMPTY ERROR ON ERROR)
        ) AS jt
      `),
      postgres18,
    );
    strict.deepStrictEqual(formattedBehavior.diagnostics, []);
    strict.strictEqual(formattedBehavior.columns[0]?.nullable, false);

    for (const invalid of [
      "SELECT * FROM JSON_TABLE('{}', $1 COLUMNS (value text)) AS jt",
      "SELECT * FROM JSON_TABLE(1, '$' COLUMNS (value text)) AS jt",
      "SELECT * FROM JSON_TABLE('{}', '$' COLUMNS (value missing_type)) AS jt",
      "SELECT * FROM JSON_TABLE('{}', '$' COLUMNS (value date EXISTS)) AS jt",
      "SELECT * FROM JSON_TABLE('{}', '$' COLUMNS (value boolean EXISTS NULL ON ERROR)) AS jt",
      "SELECT * FROM JSON_TABLE('{}', '$' COLUMNS (value text TRUE ON ERROR)) AS jt",
      "SELECT * FROM JSON_TABLE('{}', '$' COLUMNS (value integer FORMAT JSON)) AS jt",
      "SELECT * FROM JSON_TABLE('{}', '$' COLUMNS (value bytea FORMAT JSON ENCODING UTF16)) AS jt",
      "SELECT * FROM JSON_TABLE('{}', '$' COLUMNS (value integer DEFAULT $1 ON EMPTY)) AS jt",
    ]) {
      const invalidResult = resolveSelect(parseSelect(invalid), postgres18);
      strict.ok(
        invalidResult.diagnostics.some(({ code }) => code === "TSQ106" || code === "TSQ203"),
        invalid,
      );
      strict.ok(
        invalidResult.columns.some(({ tsType }) => tsType === "unknown"),
        invalid,
      );
    }

    const duplicate = resolveSelect(
      parseSelect("SELECT * FROM JSON_TABLE('{}', '$' COLUMNS (value text, value integer)) AS jt"),
      postgres18,
    );
    strict.ok(duplicate.diagnostics.some(({ code }) => code === "TSQ105"));
    const duplicatePath = resolveSelect(
      parseSelect(
        "SELECT * FROM JSON_TABLE('{}', '$' AS item COLUMNS (NESTED '$' AS item COLUMNS (value text))) AS jt",
      ),
      postgres18,
    );
    strict.ok(duplicatePath.diagnostics.some(({ code }) => code === "TSQ105"));

    const postgres16 = {
      ...postgres18,
      server: postgresServerEvidence("16.10", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    strict.ok(
      resolveSelect(
        parseSelect("SELECT * FROM JSON_TABLE('{}', '$' COLUMNS (value text)) AS jt"),
        postgres16,
      ).diagnostics.some(({ code }) => code === "TSQ403"),
    );
    strict.ok(
      resolveSelect(
        parseSelect("SELECT * FROM JSON_TABLE('{}', '$' COLUMNS (value text)) AS jt"),
        upgradeSchemaSnapshotV1(schema),
      ).diagnostics.some(({ code }) => code === "TSQ402"),
    );
  });

  await it("infers ordered parameter types from SQL context", () => {
    const parameterSchema = {
      ...schema,
      functions: {
        "label_for(integer)": {
          name: "label_for",
          argumentTypes: ["integer"],
          databaseReturnType: "text",
          returnType: "string",
          nullable: false,
        },
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect(`
      SELECT label_for($1) AS label, $7::bigint AS casted, $8 AS unresolved
      FROM users
      WHERE id = $2 AND age BETWEEN $3 AND $4 AND name IN ($5)
      LIMIT $6
    `),
      parameterSchema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(result.parameters, [
      { index: 1, tsType: "number", nullable: true, databaseType: "integer" },
      { index: 2, tsType: "number", nullable: false, databaseType: "integer" },
      { index: 3, tsType: "number", nullable: true, databaseType: "integer" },
      { index: 4, tsType: "number", nullable: true, databaseType: "integer" },
      { index: 5, tsType: "string", nullable: false, databaseType: "text" },
      { index: 6, tsType: "number", nullable: false, databaseType: "integer" },
      { index: 7, tsType: "bigint", nullable: true, databaseType: "bigint" },
      { index: 8, tsType: "unknown", nullable: true },
    ]);

    const insert = resolveStatement(parseStatement("INSERT INTO users (name, age) VALUES ($1, $2)"), schema);
    strict.deepStrictEqual(insert.parameters, [
      { index: 1, tsType: "string", nullable: false, databaseType: "text" },
      { index: 2, tsType: "number", nullable: true, databaseType: "integer" },
    ]);

    const conflict = resolveSelect(
      parseSelect("SELECT id FROM users WHERE id = $1 AND name = $1 AND age = $1"),
      schema,
    );
    strict.deepStrictEqual(conflict.parameters, [{ index: 1, tsType: "unknown", nullable: true }]);
  });

  await it("models right/full join nullability and aggregate/function policies", async () => {
    const functions = {
      ...schema,
      functions: {
        "label_for(integer)": {
          name: "label_for",
          argumentTypes: ["integer"],
          databaseReturnType: "text",
          returnType: "string",
          nullable: false,
        },
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect(`
      SELECT u.id, a.label,
             COUNT(*) AS total,
             COALESCE(a.label, 'none') AS label_or_default,
             MIN(u.age) AS minimum,
             MAX(u.age) AS maximum,
             SUM(u.age) AS sum_value,
             label_for(u.id) AS computed,
             mystery(u.id) AS unsupported
      FROM users u RIGHT JOIN ages a ON u.id = a.user_id
      GROUP BY u.id, a.label
    `),
      functions,
    );
    strict.strictEqual(result.columns.find((column) => column.name === "id")?.nullable, true);
    strict.strictEqual(result.columns.find((column) => column.name === "label")?.nullable, false);
    strict.strictEqual(result.columns.find((column) => column.name === "total")?.tsType, "bigint");
    strict.strictEqual(result.columns.find((column) => column.name === "computed")?.tsType, "string");
    strict.strictEqual(result.diagnostics.at(-1)?.code, "TSQ202");
    strict.strictEqual(result.diagnostics.at(-1)?.severity, "warning");

    const full = resolveSelect(
      parseSelect("SELECT u.id, a.label FROM users u FULL JOIN ages a ON u.id = a.user_id"),
      schema,
    );
    strict.ok(full.columns.every((column) => column.nullable));
  });

  await it("reports dialect mismatch and renders nullable rows", async () => {
    const mismatch = resolveSelect(parseSelect("SELECT id FROM users"), { ...schema, dialect: "mysql" });
    strict.strictEqual(mismatch.diagnostics[0]?.code, "TSQ007");
    strict.strictEqual(
      rowTypeLiteral([
        { name: "value", tsType: "string", nullable: true, range: { start: 0, end: 1, line: 1, column: 1 } },
      ]),
      '{ "value": string | null; }',
    );
  });

  await it("expands stars and models JOIN USING as one unambiguous property", () => {
    const result = resolveSelect(
      parseSelect(`
      SELECT *
      FROM users u
      LEFT JOIN ages a USING (id)
    `),
      {
        ...schema,
        tables: {
          users: schema.tables.users,
          ages: {
            ...schema.tables.ages,
            columns: {
              id: { name: "id", databaseType: "integer", tsType: "number", nullable: false },
              label: schema.tables.ages.columns.label,
            },
          },
        },
      },
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, nullable }) => ({ name, nullable })),
      [
        { name: "id", nullable: false },
        { name: "name", nullable: false },
        { name: "age", nullable: true },
        { name: "label", nullable: true },
      ],
    );
  });

  await it("resolves CTEs, derived tables, correlated scalar subqueries, EXISTS, and IN", () => {
    const result = resolveStatement(
      parseStatement(`
      WITH named AS (
        SELECT u.id, u.name FROM users u WHERE EXISTS (SELECT 1 AS one FROM ages a WHERE a.user_id = u.id)
      )
      SELECT n.id,
             n.name,
             (SELECT a.label FROM ages a WHERE a.user_id = n.id LIMIT 1) AS label
      FROM (SELECT id, name FROM named) n
      WHERE n.id IN (SELECT user_id FROM ages)
    `),
      schema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, tsType, nullable }) => ({ name, tsType, nullable })),
      [
        { name: "id", tsType: "number", nullable: false },
        { name: "name", tsType: "string", nullable: false },
        { name: "label", tsType: "string", nullable: true },
      ],
    );
  });

  await it("infers data-changing RETURNING rows and uses never for command-only statements", () => {
    const insert = resolveStatement(
      parseStatement("INSERT INTO users (name, age) VALUES ('Ada', 37) RETURNING id, name"),
      schema,
    );
    strict.strictEqual(insert.resultKind, "rows");
    strict.deepStrictEqual(
      insert.columns.map(({ name, tsType }) => ({ name, tsType })),
      [
        { name: "id", tsType: "number" },
        { name: "name", tsType: "string" },
      ],
    );
    const update = resolveStatement(
      parseStatement("UPDATE users u SET age = age + 1 WHERE u.id = $1 RETURNING u.*"),
      schema,
    );
    strict.strictEqual(update.resultKind, "rows");
    strict.strictEqual(update.columns.length, 3);
    const deletion = resolveStatement(parseStatement("DELETE FROM users WHERE id = $1"), schema);
    strict.strictEqual(deletion.resultKind, "command");
    strict.deepStrictEqual(deletion.columns, []);
    const mismatch = resolveStatement(parseStatement("INSERT INTO users (name) VALUES ('Ada', 'extra')"), schema);
    strict.ok(mismatch.diagnostics.some((diagnostic) => diagnostic.code === "TSQ214"));
  });

  await it("uses v2 write eligibility and required-column evidence without changing v1 behavior", () => {
    const invalidInsert = resolveStatement(parseStatement("INSERT INTO users (id) VALUES (1)"), v2Schema);
    strict.deepStrictEqual(
      invalidInsert.diagnostics.map(({ code }) => code),
      ["TSQ218", "TSQ219"],
    );
    strict.ok(
      resolveStatement(parseStatement("INSERT INTO users DEFAULT VALUES"), v2Schema).diagnostics.some(
        ({ code }) => code === "TSQ219",
      ),
    );
    const invalidUpdate = resolveStatement(parseStatement("UPDATE users SET age = 1"), v2Schema);
    strict.ok(invalidUpdate.diagnostics.some(({ code }) => code === "TSQ218"));
    strict.deepStrictEqual(
      resolveStatement(parseStatement("INSERT INTO users (id) VALUES (1)"), schema).diagnostics,
      [],
    );
  });

  await it("uses v2 primary-key evidence for PostgreSQL grouping functional dependencies", () => {
    const users = v2Schema.relations.users!;
    const primarySchema = {
      ...v2Schema,
      relations: {
        ...v2Schema.relations,
        users: {
          ...users,
          columns: {
            ...users.columns,
            age: { ...users.columns.age!, updatable: true },
          },
          constraints: [
            {
              kind: "primary-key",
              identity: "users_pkey",
              columns: ["id"],
              partial: false,
              expressionBased: false,
              deferrable: false,
              initiallyDeferred: false,
              nullsDistinct: false,
            },
          ],
        },
      },
    } as const satisfies SchemaSnapshot;
    const dependent = resolveSelect(
      parseSelect("SELECT id, name, COUNT(*) AS total FROM users GROUP BY id"),
      primarySchema,
    );
    strict.deepStrictEqual(dependent.diagnostics, []);
    const omittedKey = resolveSelect(
      parseSelect("SELECT name, COUNT(*) AS total FROM users GROUP BY GROUPING SETS ((id), ())"),
      primarySchema,
    );
    strict.ok(omittedKey.diagnostics.some(({ code }) => code === "TSQ228"));
  });

  await it("uses snapshot v2 table-returning routine shapes in function relations", () => {
    const routineSchema = {
      ...v2Schema,
      routines: {
        "public.list_users()": [
          {
            name: "list_users",
            schema: "public",
            identity: "public.list_users()",
            kind: "function",
            arguments: [],
            result: {
              kind: "table",
              columns: {
                id: {
                  name: "id",
                  position: 1,
                  typeIdentity: "pg_catalog.int4",
                  databaseType: "integer",
                  tsType: "number",
                  nullable: false,
                  nullabilitySource: "declared",
                  default: "none",
                  generated: "none",
                  identity: "none",
                  classification: "normal",
                  insertable: false,
                  updatable: false,
                },
                name: {
                  name: "name",
                  position: 2,
                  typeIdentity: "pg_catalog.text",
                  databaseType: "text",
                  tsType: "string",
                  nullable: true,
                  nullabilitySource: "declared",
                  default: "none",
                  generated: "none",
                  identity: "none",
                  classification: "normal",
                  insertable: false,
                  updatable: false,
                },
              },
            },
            volatility: "stable",
            deterministic: "unknown",
            dataAccess: "reads-sql",
            nullInput: "called",
          },
        ],
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect("SELECT listed.id, listed.name FROM public.list_users() AS listed"),
      routineSchema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ tsType, nullable }) => ({ tsType, nullable })),
      [
        { tsType: "number", nullable: false },
        { tsType: "string", nullable: true },
      ],
    );
  });

  await it("resolves PostgreSQL conflict namespaces, identity overriding, MERGE, and v18 RETURNING aliases", () => {
    const users = v2Schema.relations.users!;
    const dmlSchema = {
      ...v2Schema,
      server: postgresServerEvidence("18.6", [], { standardConformingStrings: "on" }),
      relations: {
        ...v2Schema.relations,
        users: {
          ...users,
          constraints: [
            {
              kind: "primary-key",
              identity: "users_pkey",
              columns: ["id"],
              partial: false,
              expressionBased: false,
              deferrable: false,
              initiallyDeferred: false,
              nullsDistinct: false,
            },
          ],
          indexes: [
            {
              name: "users_lower_name_active_key",
              identity: "users.users_lower_name_active_key",
              unique: true,
              method: "btree",
              columns: [
                {
                  expressionHash: fingerprintPostgresExpressionSql("name || ''"),
                  operatorClass: "pg_catalog.text_ops",
                  collation: "pg_catalog.default",
                },
              ],
              predicate: "present",
              predicateHash: fingerprintPostgresExpressionSql("age > 0"),
              valid: true,
            },
          ],
        },
      },
    } as const satisfies SchemaSnapshot;

    const conflict = resolveStatement(
      parseStatement(`
        INSERT INTO users (id, name, age) OVERRIDING SYSTEM VALUE
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO UPDATE
          SET name = excluded.name
          WHERE users.id = excluded.id
        RETURNING WITH (OLD AS previous, NEW AS current)
          previous.name AS old_name, current.name AS new_name
      `),
      dmlSchema,
    );
    strict.deepStrictEqual(conflict.diagnostics, []);
    strict.deepStrictEqual(
      conflict.parameters.map(({ index, tsType }) => ({ index, tsType })),
      [
        { index: 1, tsType: "number" },
        { index: 2, tsType: "string" },
        { index: 3, tsType: "number" },
      ],
    );
    strict.deepStrictEqual(
      conflict.columns.map(({ name, tsType, nullable }) => ({ name, tsType, nullable })),
      [
        { name: "old_name", tsType: "string", nullable: true },
        { name: "new_name", tsType: "string", nullable: false },
      ],
    );

    const expressionConflict = resolveStatement(
      parseStatement(`
        INSERT INTO users (name, age) VALUES ('Ada', 1)
        ON CONFLICT ((name || '') COLLATE "default" text_ops) WHERE age > 0 DO NOTHING
      `),
      dmlSchema,
    );
    strict.deepStrictEqual(expressionConflict.diagnostics, []);
    strict.deepStrictEqual(
      resolveStatement(
        parseStatement(`
          INSERT INTO users (name, age) VALUES ('Ada', 1)
          ON CONFLICT ((name || '') COLLATE pg_catalog."default" pg_catalog.text_ops)
          WHERE age > 0 DO NOTHING
        `),
        dmlSchema,
      ).diagnostics,
      [],
    );
    const unknownIndexSchema = {
      ...dmlSchema,
      relations: {
        ...dmlSchema.relations,
        users: {
          ...dmlSchema.relations.users!,
          constraints: [],
          indexes: dmlSchema.relations.users!.indexes.map((index) => ({ ...index, valid: "unknown" as const })),
        },
      },
    } as const satisfies SchemaSnapshot;
    strict.ok(
      resolveStatement(
        parseStatement(`
          INSERT INTO users (name, age) VALUES ('Ada', 1)
          ON CONFLICT ((name || '')) WHERE age > 0 DO NOTHING
        `),
        unknownIndexSchema,
      ).diagnostics.some(({ code }) => code === "TSQ402"),
    );
    const invalidIndexSchema = {
      ...unknownIndexSchema,
      relations: {
        ...unknownIndexSchema.relations,
        users: {
          ...unknownIndexSchema.relations.users!,
          indexes: unknownIndexSchema.relations.users!.indexes.map((index) => ({ ...index, valid: false })),
        },
      },
    } as const satisfies SchemaSnapshot;
    strict.ok(
      resolveStatement(
        parseStatement("INSERT INTO users (name, age) VALUES ('Ada', 1) ON CONFLICT ((name || '')) DO NOTHING"),
        invalidIndexSchema,
      ).diagnostics.some(({ code }) => code === "TSQ226"),
    );
    const unknownPredicateSchema = {
      ...dmlSchema,
      relations: {
        ...dmlSchema.relations,
        users: {
          ...dmlSchema.relations.users!,
          constraints: [],
          indexes: dmlSchema.relations.users!.indexes.map(({ predicateHash: _predicateHash, ...index }) => ({
            ...index,
            predicate: "unknown" as const,
          })),
        },
      },
    } as const satisfies SchemaSnapshot;
    strict.ok(
      resolveStatement(
        parseStatement(`
          INSERT INTO users (name, age) VALUES ('Ada', 1)
          ON CONFLICT ((name || '')) WHERE age > 0 DO NOTHING
        `),
        unknownPredicateSchema,
      ).diagnostics.some(({ code }) => code === "TSQ402"),
    );
    const missingPredicateHashSchema = {
      ...dmlSchema,
      relations: {
        ...dmlSchema.relations,
        users: {
          ...dmlSchema.relations.users!,
          constraints: [],
          indexes: dmlSchema.relations.users!.indexes.map(({ predicateHash: _predicateHash, ...index }) => index),
        },
      },
    } as const satisfies SchemaSnapshot;
    strict.ok(
      resolveStatement(
        parseStatement(`
          INSERT INTO users (name, age) VALUES ('Ada', 1)
          ON CONFLICT ((name || '')) WHERE age > 0 DO NOTHING
        `),
        missingPredicateHashSchema,
      ).diagnostics.some(({ code }) => code === "TSQ402"),
    );
    const incompleteElementSchema = {
      ...dmlSchema,
      relations: {
        ...dmlSchema.relations,
        users: {
          ...dmlSchema.relations.users!,
          constraints: [],
          indexes: dmlSchema.relations.users!.indexes.map((index) => ({
            ...index,
            columns: [{}],
            predicate: "none" as const,
          })),
        },
      },
    } as const satisfies SchemaSnapshot;
    strict.ok(
      resolveStatement(
        parseStatement("INSERT INTO users (name) VALUES ('Ada') ON CONFLICT (name) DO NOTHING"),
        incompleteElementSchema,
      ).diagnostics.some(({ code }) => code === "TSQ402"),
    );
    const nonPartialExpressionSchema = {
      ...dmlSchema,
      relations: {
        ...dmlSchema.relations,
        users: {
          ...dmlSchema.relations.users!,
          constraints: [],
          indexes: dmlSchema.relations.users!.indexes.map(({ predicateHash: _predicateHash, ...index }) => ({
            ...index,
            predicate: "none" as const,
          })),
        },
      },
    } as const satisfies SchemaSnapshot;
    strict.deepStrictEqual(
      resolveStatement(
        parseStatement(`
          INSERT INTO users (name, age) VALUES ('Ada', 1)
          ON CONFLICT ((name || '')) WHERE age > 0 DO NOTHING
        `),
        nonPartialExpressionSchema,
      ).diagnostics,
      [],
    );
    strict.ok(
      resolveStatement(
        parseStatement("INSERT INTO users (name, age) VALUES ('Ada', 1) ON CONFLICT ((name || '')) DO NOTHING"),
        schema,
      ).diagnostics.some(({ code }) => code === "TSQ402"),
    );
    for (const [deferrable, code] of [
      [true, "TSQ224"],
      ["unknown", "TSQ402"],
    ] as const) {
      const constraintSchema = {
        ...dmlSchema,
        relations: {
          ...dmlSchema.relations,
          users: {
            ...dmlSchema.relations.users!,
            constraints: dmlSchema.relations.users!.constraints.map((constraint) => ({
              ...constraint,
              deferrable,
            })),
          },
        },
      } as const satisfies SchemaSnapshot;
      strict.ok(
        resolveStatement(
          parseStatement(
            "INSERT INTO users (name, age) VALUES ('Ada', 1) ON CONFLICT ON CONSTRAINT users_pkey DO NOTHING",
          ),
          constraintSchema,
        ).diagnostics.some((diagnostic) => diagnostic.code === code),
      );
    }
    strict.ok(
      resolveStatement(
        parseStatement(`
          INSERT INTO users (name, age) VALUES ('Ada', 1)
          ON CONFLICT ((name || '') text_ops) WHERE age > 1 DO NOTHING
        `),
        dmlSchema,
      ).diagnostics.some(({ code }) => code === "TSQ402"),
    );
    strict.deepStrictEqual(
      resolveStatement(
        parseStatement("INSERT INTO users (name, age) VALUES ('Ada', 1) ON CONFLICT (id) WHERE age > 0 DO NOTHING"),
        dmlSchema,
      ).diagnostics,
      [],
    );
    strict.deepStrictEqual(
      resolveStatement(
        parseStatement(`
          MERGE INTO users AS target
          USING (VALUES (1)) source(id) ON target.id = source.id
          WHEN MATCHED THEN DO NOTHING
        `),
        dmlSchema,
      ).diagnostics,
      [],
    );
    strict.deepStrictEqual(
      resolveStatement(parseStatement("INSERT INTO users (name) VALUES ('Ada') ON CONFLICT (\"id\") DO NOTHING"), {
        ...dmlSchema,
        relations: {
          ...dmlSchema.relations,
          users: { ...dmlSchema.relations.users!, indexes: [] },
        },
      }).diagnostics,
      [],
    );
    const conflictEvidenceCases = [
      {
        schema: {
          ...dmlSchema,
          relations: {
            ...dmlSchema.relations,
            users: {
              ...dmlSchema.relations.users!,
              constraints: [],
              indexes: dmlSchema.relations.users!.indexes.map((index) => ({ ...index, unique: false })),
            },
          },
        } as const satisfies SchemaSnapshot,
        sql: "INSERT INTO users (name) VALUES ('Ada') ON CONFLICT (name) DO NOTHING",
        code: "TSQ226",
      },
      {
        schema: {
          ...nonPartialExpressionSchema,
          relations: {
            ...nonPartialExpressionSchema.relations,
            users: {
              ...nonPartialExpressionSchema.relations.users!,
              indexes: nonPartialExpressionSchema.relations.users!.indexes.map((index) => ({
                ...index,
                columns: index.columns.map(({ operatorClass: _operatorClass, ...column }) => column),
              })),
            },
          },
        } as const satisfies SchemaSnapshot,
        sql: "INSERT INTO users (name) VALUES ('Ada') ON CONFLICT ((name || '') text_ops) DO NOTHING",
        code: "TSQ226",
      },
      {
        schema: {
          ...dmlSchema,
          relations: {
            ...dmlSchema.relations,
            users: {
              ...dmlSchema.relations.users!,
              constraints: [],
              indexes: dmlSchema.relations.users!.indexes.map((index) => ({
                ...index,
                predicate: "unknown" as const,
              })),
            },
          },
        } as const satisfies SchemaSnapshot,
        sql: "INSERT INTO users (name) VALUES ('Ada') ON CONFLICT ((name || '')) DO NOTHING",
        code: "TSQ402",
      },
    ];
    for (const evidenceCase of conflictEvidenceCases) {
      strict.ok(
        resolveStatement(parseStatement(evidenceCase.sql), evidenceCase.schema).diagnostics.some(
          ({ code }) => code === evidenceCase.code,
        ),
      );
    }

    const merge = resolveStatement(
      parseStatement(`
        MERGE INTO users AS target
        USING ages AS source
        ON target.id = source.user_id
        WHEN MATCHED THEN UPDATE SET name = source.label
        WHEN NOT MATCHED BY TARGET THEN
          INSERT (name, age) VALUES (source.label, $1)
        WHEN NOT MATCHED BY SOURCE THEN DELETE
        RETURNING merge_action() AS action, target.id
      `),
      dmlSchema,
    );
    strict.deepStrictEqual(merge.diagnostics, []);
    strict.deepStrictEqual(
      merge.parameters.map(({ index, tsType }) => ({ index, tsType })),
      [{ index: 1, tsType: "number" }],
    );
    strict.deepStrictEqual(
      merge.columns.map(({ name, tsType }) => ({ name, tsType })),
      [
        { name: "action", tsType: "string" },
        { name: "id", tsType: "number" },
      ],
    );
    strict.deepStrictEqual(
      resolveStatement(
        parseStatement(`
          MERGE INTO users AS target
          USING (VALUES (1)) ON target.id = column1
          WHEN MATCHED THEN DO NOTHING
        `),
        dmlSchema,
      ).diagnostics,
      [],
    );

    const postgres16 = {
      ...dmlSchema,
      server: postgresServerEvidence("16.15", [], { standardConformingStrings: "on" }),
    };
    strict.ok(
      resolveStatement(
        parseStatement(
          "MERGE INTO users u USING ages a ON u.id = a.user_id WHEN MATCHED THEN DO NOTHING RETURNING u.id",
        ),
        postgres16,
      ).diagnostics.some(({ code }) => code === "TSQ403"),
    );
    strict.ok(
      resolveStatement(
        parseStatement(
          "MERGE INTO users u USING ages a ON u.id = a.user_id WHEN NOT MATCHED BY TARGET THEN DO NOTHING",
        ),
        postgres16,
      ).diagnostics.some(({ code }) => code === "TSQ403"),
    );

    for (const invalid of [
      "INSERT INTO users (name) VALUES ('Ada') ON CONFLICT DO UPDATE SET name = excluded.name",
      "INSERT INTO users (name) VALUES ('Ada') ON CONFLICT ON CONSTRAINT missing DO NOTHING",
      "INSERT INTO users (name) VALUES ('Ada') ON CONFLICT ((name)) WHERE age > 0 DO NOTHING",
      "INSERT INTO users (name, age) VALUES ('Ada', 1) ON CONFLICT (id) DO UPDATE SET name = excluded.name RETURNING excluded.name",
      "INSERT INTO users AS excluded (name, age) VALUES ('Ada', 1) ON CONFLICT (id) DO UPDATE SET name = excluded.name",
      "UPDATE users SET (name, name) = ROW($1)",
      "MERGE INTO users u USING ages a ON u.id = a.user_id WHEN NOT MATCHED THEN UPDATE SET name = a.label",
      "MERGE INTO users u USING ages a ON u.id = a.user_id WHEN NOT MATCHED THEN DELETE",
      "MERGE INTO users u USING ages a ON u.id = a.user_id WHEN MATCHED THEN DO NOTHING WHEN MATCHED THEN DELETE",
      "MERGE INTO users u USING (VALUES (1), (2, 'extra')) AS source(id) ON u.id = source.id WHEN MATCHED THEN DO NOTHING",
      "MERGE INTO users u USING ages a ON u.id = a.user_id WHEN NOT MATCHED THEN INSERT OVERRIDING USER VALUE DEFAULT VALUES",
    ]) {
      strict.ok(resolveStatement(parseStatement(invalid), dmlSchema).diagnostics.length > 0, invalid);
    }
    strict.ok(
      resolveSelect(parseSelect("SELECT merge_action() AS action"), dmlSchema).diagnostics.some(
        ({ code }) => code === "TSQ227",
      ),
    );
    strict.ok(
      resolveStatement(
        parseStatement("UPDATE users SET name = 'Ada' RETURNING WITH (OLD AS before) before.name"),
        postgres16,
      ).diagnostics.some(({ code }) => code === "TSQ403"),
    );
    strict.ok(
      resolveStatement(parseStatement("UPDATE users SET name = 'Ada' RETURNING old.name"), postgres16).diagnostics.some(
        ({ code }) => code === "TSQ403",
      ),
    );
    strict.deepStrictEqual(
      resolveStatement(parseStatement("UPDATE users AS old SET name = 'Ada' RETURNING old.name"), postgres16)
        .diagnostics,
      [],
    );
    strict.deepStrictEqual(
      resolveStatement(
        parseStatement(
          "UPDATE users SET name = 'Ada' RETURNING WITH (OLD AS before) before.name AS old_name, new.name AS new_name",
        ),
        dmlSchema,
      ).diagnostics,
      [],
    );
    strict.deepStrictEqual(
      resolveStatement(parseStatement("INSERT INTO users (id, name) VALUES (DEFAULT, 'Ada')"), dmlSchema).diagnostics,
      [],
    );
    strict.ok(
      resolveStatement(
        parseStatement(
          "UPDATE users SET name = 'Ada' RETURNING WITH (OLD AS row_value, NEW AS row_value) row_value.name",
        ),
        dmlSchema,
      ).diagnostics.some(({ code }) => code === "TSQ108"),
    );
  });

  await it("resolves arrays, JSON operators, filtered windows, and exact overloads", () => {
    const richSchema = {
      ...schema,
      tables: {
        ...schema.tables,
        events: {
          name: "events",
          columns: {
            payload: { name: "payload", databaseType: "jsonb", tsType: "unknown", nullable: false },
            scores: {
              name: "scores",
              databaseType: "integer[]",
              tsType: "readonly (number)[]",
              nullable: false,
              array: true,
            },
            active: { name: "active", databaseType: "boolean", tsType: "boolean", nullable: false },
            team_id: { name: "team_id", databaseType: "integer", tsType: "number", nullable: false },
          },
        },
      },
      functions: {
        "label_for(integer)": {
          name: "label_for",
          argumentTypes: ["integer"],
          databaseReturnType: "text",
          returnType: "string",
          nullable: false,
        },
        "label_for(text)": {
          name: "label_for",
          argumentTypes: ["text"],
          databaseReturnType: "text",
          returnType: "string",
          nullable: true,
        },
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect(`
      SELECT ARRAY[1, 2] AS ids,
             payload->>'name' AS name,
             scores || ARRAY[3] AS all_scores,
             scores[1] AS first_score,
             scores[1:2] AS top_scores,
             ('(1,2)'::point)[0] AS x_coordinate,
             team_id = ANY(scores) AS any_score,
             team_id = ALL($1) AS every_score,
             team_id = SOME(SELECT candidate.team_id FROM events candidate) AS subquery_score,
             (team_id, active) = ANY(
               SELECT candidate.team_id, candidate.active FROM events candidate
             ) AS row_subquery_matches,
             (team_id, active) = ($2, $3) AS row_matches,
             (team_id, active) IS DISTINCT FROM (NULL, false) AS row_differs,
             (team_id, active) IN ((1, true), ($4, $5)) AS row_in_list,
             (team_id, active) IN (
               SELECT candidate.team_id, candidate.active FROM events candidate
             ) AS row_in_subquery,
             $6 IN (team_id) AS contextual_subject_in,
             $7 IN ($8) AS inferred_text_in,
             COUNT(*) FILTER (WHERE active) OVER (PARTITION BY team_id) AS active_count,
             label_for(team_id) AS team_label
      FROM events
    `),
      richSchema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, tsType }) => ({ name, tsType })),
      [
        { name: "ids", tsType: "readonly (number)[]" },
        { name: "name", tsType: "string" },
        { name: "all_scores", tsType: "readonly (number)[]" },
        { name: "first_score", tsType: "number" },
        { name: "top_scores", tsType: "readonly (number)[]" },
        { name: "x_coordinate", tsType: "number" },
        { name: "any_score", tsType: "boolean" },
        { name: "every_score", tsType: "boolean" },
        { name: "subquery_score", tsType: "boolean" },
        { name: "row_subquery_matches", tsType: "boolean" },
        { name: "row_matches", tsType: "boolean" },
        { name: "row_differs", tsType: "boolean" },
        { name: "row_in_list", tsType: "boolean" },
        { name: "row_in_subquery", tsType: "boolean" },
        { name: "contextual_subject_in", tsType: "boolean" },
        { name: "inferred_text_in", tsType: "boolean" },
        { name: "active_count", tsType: "bigint" },
        { name: "team_label", tsType: "string" },
      ],
    );
    strict.strictEqual(result.columns.find(({ name }) => name === "first_score")?.nullable, true);
    strict.strictEqual(result.columns.find(({ name }) => name === "any_score")?.nullable, true);
    strict.strictEqual(result.columns.find(({ name }) => name === "subquery_score")?.nullable, false);
    strict.strictEqual(result.columns.find(({ name }) => name === "row_subquery_matches")?.nullable, false);
    strict.strictEqual(result.columns.find(({ name }) => name === "row_matches")?.nullable, true);
    strict.strictEqual(result.columns.find(({ name }) => name === "row_differs")?.nullable, false);
    strict.strictEqual(result.columns.find(({ name }) => name === "row_in_list")?.nullable, false);
    strict.strictEqual(result.columns.find(({ name }) => name === "row_in_subquery")?.nullable, false);
    strict.strictEqual(result.columns.find(({ name }) => name === "contextual_subject_in")?.nullable, true);
    strict.strictEqual(result.columns.find(({ name }) => name === "inferred_text_in")?.nullable, true);
    strict.deepStrictEqual(
      result.parameters.map(({ index, tsType }) => ({ index, tsType })),
      [
        { index: 1, tsType: "readonly (number)[]" },
        { index: 2, tsType: "number" },
        { index: 3, tsType: "boolean" },
        { index: 4, tsType: "number" },
        { index: 5, tsType: "boolean" },
        { index: 6, tsType: "number" },
        { index: 7, tsType: "string" },
        { index: 8, tsType: "string" },
      ],
    );
    strict.deepStrictEqual(
      resolveSelect(parseSelect("SELECT scores['x'] FROM events"), richSchema).diagnostics.map(({ code }) => code),
      ["TSQ203"],
    );
    strict.deepStrictEqual(
      resolveSelect(parseSelect("SELECT team_id[1] FROM events"), richSchema).diagnostics.map(({ code }) => code),
      ["TSQ203"],
    );
    const parameterized = resolveSelect(parseSelect("SELECT scores[$1] FROM events"), richSchema);
    strict.deepStrictEqual(
      parameterized.parameters.map(({ index, tsType }) => ({ index, tsType })),
      [{ index: 1, tsType: "number" }],
    );
    for (const query of [
      "SELECT team_id = ANY(1) FROM events",
      "SELECT active = ANY(scores) FROM events",
      "SELECT (team_id, active) = (1) FROM events",
      "SELECT active IN (scores) FROM events",
      "SELECT team_id IN ('not-a-number') FROM events",
      "SELECT 'not-a-number' IN (team_id) FROM events",
      "SELECT team_id IN ((1, 2)) FROM events",
      "SELECT (team_id, active) IN ((1)) FROM events",
      "SELECT (team_id, active) IN (1, ROW(1, true)) FROM events",
      "SELECT (team_id, active) IN (SELECT candidate.team_id FROM events candidate) FROM events",
      "SELECT team_id IN (SELECT candidate.team_id, candidate.active FROM events candidate) FROM events",
    ]) {
      strict.ok(
        resolveSelect(parseSelect(query), richSchema).diagnostics.some(
          ({ code }) => code === "TSQ203" || code === "TSQ217",
        ),
        query,
      );
    }
    strict.deepStrictEqual(
      resolveSelect(parseSelect("SELECT team_id = ANY(ARRAY[]) AS matches FROM events"), richSchema).diagnostics,
      [],
    );
    const scalarIn = resolveSelect(
      parseSelect("SELECT '2' IN (team_id) AS numeric_text, team_id IN (NULL) AS nullable_match FROM events"),
      richSchema,
    );
    strict.deepStrictEqual(scalarIn.diagnostics, []);
    strict.strictEqual(scalarIn.columns.find(({ name }) => name === "nullable_match")?.nullable, true);
  });

  await it("resolves snapshot-backed composite field selection", () => {
    const compositeBase = upgradeSchemaSnapshotV1({
      formatVersion: 1,
      dialect: "postgres",
      tables: {
        people: {
          name: "people",
          columns: {
            profile: {
              name: "profile",
              databaseType: "address",
              tsType: "{ readonly zip: number; readonly DisplayName: string | null; }",
              nullable: false,
            },
          },
        },
      },
    });
    const compositeSchema = {
      ...compositeBase,
      types: {
        ...compositeBase.types,
        integer: {
          kind: "scalar",
          name: "int4",
          identity: "pg:23",
          databaseType: "integer",
          tsType: "number",
        },
        address: {
          kind: "composite",
          name: "address",
          schema: "public",
          identity: "pg:address",
          databaseType: "address",
          tsType: "{ readonly zip: number; readonly DisplayName: string | null; }",
          fields: [
            { name: "zip", typeIdentity: "pg:23", databaseType: "integer", tsType: "number", nullable: false },
            {
              name: "DisplayName",
              typeIdentity: "pg:25",
              databaseType: "text",
              tsType: "string",
              nullable: true,
            },
          ],
        },
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect(`
        SELECT (profile).zip AS zip,
               (profile)."DisplayName" AS label,
               ($1::address).zip AS input_zip,
               profile IN ($2) AS profile_matches,
               profile = $3 AS profile_equal,
               $4 IS DISTINCT FROM profile AS profile_differs,
               profile < $5 AS profile_before
        FROM people
      `),
      compositeSchema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, tsType, nullable }) => ({ name, tsType, nullable })),
      [
        { name: "zip", tsType: "number", nullable: false },
        { name: "label", tsType: "string", nullable: true },
        { name: "input_zip", tsType: "number", nullable: true },
        { name: "profile_matches", tsType: "boolean", nullable: false },
        { name: "profile_equal", tsType: "boolean", nullable: true },
        { name: "profile_differs", tsType: "boolean", nullable: false },
        { name: "profile_before", tsType: "boolean", nullable: true },
      ],
    );
    strict.deepStrictEqual(
      result.parameters.map(({ index, tsType }) => ({ index, tsType })),
      [
        { index: 1, tsType: "{ readonly zip: number; readonly DisplayName: string | null; }" },
        { index: 2, tsType: "{ readonly zip: number; readonly DisplayName: string | null; }" },
        { index: 3, tsType: "{ readonly zip: number; readonly DisplayName: string | null; }" },
        { index: 4, tsType: "{ readonly zip: number; readonly DisplayName: string | null; }" },
        { index: 5, tsType: "{ readonly zip: number; readonly DisplayName: string | null; }" },
      ],
    );

    const unknownField = resolveSelect(parseSelect("SELECT (profile).missing FROM people"), compositeSchema);
    strict.ok(unknownField.diagnostics.some(({ code }) => code === "TSQ101"));
    const nonComposite = resolveSelect(parseSelect("SELECT ((profile).zip).missing FROM people"), compositeSchema);
    strict.ok(nonComposite.diagnostics.some(({ code }) => code === "TSQ203"));
    const invalidComposite = resolveSelect(parseSelect("SELECT profile = 1 FROM people"), compositeSchema);
    strict.ok(invalidComposite.diagnostics.some(({ code }) => code === "TSQ203"));
  });

  await it("resolves COLLATE and exact AT TIME ZONE signatures", () => {
    const temporalSchema = {
      ...schema,
      tables: {
        ...schema.tables,
        events: {
          name: "events",
          columns: {
            title: { name: "title", databaseType: "text", tsType: "string", nullable: false },
            local_time: { name: "local_time", databaseType: "timestamp", tsType: "Date", nullable: false },
            instant: { name: "instant", databaseType: "timestamptz", tsType: "Date", nullable: true },
            local_clock: { name: "local_clock", databaseType: "time", tsType: "string", nullable: false },
            clock: { name: "clock", databaseType: "timetz", tsType: "string", nullable: false },
            zone_interval: {
              name: "zone_interval",
              databaseType: "interval",
              tsType: "string",
              nullable: false,
            },
            count: { name: "count", databaseType: "integer", tsType: "number", nullable: false },
          },
        },
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect(`
        SELECT title COLLATE pg_catalog."C",
               local_time AT TIME ZONE $1 AS instant_from_local,
               instant AT TIME ZONE 'UTC' AS local_from_instant,
               clock AT TIME ZONE zone_interval AS shifted_clock,
               title = ($2 COLLATE "C") AS title_matches,
               NULL COLLATE "default" AS nullable_text
        FROM events
      `),
      temporalSchema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, databaseType, tsType, nullable }) => ({ name, databaseType, tsType, nullable })),
      [
        { name: "title", databaseType: "text", tsType: "string", nullable: false },
        { name: "instant_from_local", databaseType: "timestamptz", tsType: "Date", nullable: true },
        { name: "local_from_instant", databaseType: "timestamp", tsType: "Date", nullable: true },
        { name: "shifted_clock", databaseType: "timetz", tsType: "string", nullable: false },
        { name: "title_matches", databaseType: "boolean", tsType: "boolean", nullable: true },
        { name: "nullable_text", databaseType: undefined, tsType: "unknown", nullable: true },
      ],
    );
    strict.deepStrictEqual(
      result.parameters.map(({ index, tsType }) => ({ index, tsType })),
      [
        { index: 1, tsType: "string" },
        { index: 2, tsType: "string" },
      ],
    );

    const postgres17 = {
      ...temporalSchema,
      server: postgresServerEvidence("17.6", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    const local = resolveSelect(
      parseSelect("SELECT local_time AT LOCAL AS instant, instant AT LOCAL AS local_time FROM events"),
      postgres17,
    );
    strict.deepStrictEqual(local.diagnostics, []);
    strict.deepStrictEqual(
      local.columns.map(({ databaseType, nullable }) => ({ databaseType, nullable })),
      [
        { databaseType: "timestamptz", nullable: false },
        { databaseType: "timestamp", nullable: true },
      ],
    );
    const postgres16 = {
      ...temporalSchema,
      server: postgresServerEvidence("16.10", [], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    strict.ok(
      resolveSelect(parseSelect("SELECT instant AT LOCAL FROM events"), postgres16).diagnostics.some(
        ({ code }) => code === "TSQ403",
      ),
    );

    for (const invalid of [
      'SELECT count COLLATE "C" FROM events',
      "SELECT title AT TIME ZONE 'UTC' FROM events",
      "SELECT local_time AT TIME ZONE count FROM events",
      "SELECT local_clock AT TIME ZONE 'UTC' FROM events",
    ]) {
      strict.ok(
        resolveSelect(parseSelect(invalid), temporalSchema).diagnostics.some(({ code }) => code === "TSQ203"),
        invalid,
      );
    }
  });

  await it("resolves v2 polymorphic and implicitly coercible routine overloads", () => {
    const routineDefaults = {
      kind: "function",
      volatility: "immutable",
      deterministic: true,
      dataAccess: "none",
      nullInput: "strict",
    } as const;
    const polymorphicSchema = {
      ...v2Schema,
      routines: {
        same: [
          {
            ...routineDefaults,
            name: "same",
            identity: "public.same(anyelement,anyelement)",
            arguments: ["left", "right"].map((name) => ({
              name,
              mode: "in" as const,
              typeIdentity: "anyelement",
              databaseType: "anyelement",
              tsType: "unknown",
              default: "none" as const,
            })),
            result: {
              kind: "scalar",
              typeIdentity: "anyelement",
              databaseType: "anyelement",
              tsType: "unknown",
              nullable: false,
            },
            polymorphicFamily: "simple",
          },
        ],
        make_array2: [
          {
            ...routineDefaults,
            name: "make_array2",
            identity: "public.make_array2(anycompatible,anycompatible)",
            arguments: ["left", "right"].map((name) => ({
              name,
              mode: "in" as const,
              typeIdentity: "anycompatible",
              databaseType: "anycompatible",
              tsType: "unknown",
              default: "none" as const,
            })),
            result: {
              kind: "scalar",
              typeIdentity: "anycompatiblearray",
              databaseType: "anycompatiblearray",
              tsType: "unknown",
              nullable: false,
            },
            polymorphicFamily: "compatible",
          },
        ],
        format_value: [
          {
            ...routineDefaults,
            name: "format_value",
            identity: "public.format_value(text,integer)",
            arguments: [
              {
                name: "prefix",
                mode: "in",
                typeIdentity: "text",
                databaseType: "text",
                tsType: "string",
                default: "none",
              },
              {
                name: "value",
                mode: "in",
                typeIdentity: "integer",
                databaseType: "integer",
                tsType: "number",
                default: "present",
              },
            ],
            result: {
              kind: "scalar",
              typeIdentity: "text",
              databaseType: "text",
              tsType: "string",
              nullable: false,
            },
          },
        ],
        sum_many: [
          {
            ...routineDefaults,
            name: "sum_many",
            identity: "public.sum_many(numeric[])",
            arguments: [
              {
                name: "values",
                mode: "variadic",
                typeIdentity: "numeric[]",
                databaseType: "numeric[]",
                tsType: "readonly string[]",
                default: "none",
              },
            ],
            result: {
              kind: "scalar",
              typeIdentity: "numeric",
              databaseType: "numeric",
              tsType: "string",
              nullable: false,
            },
          },
        ],
        widen: [
          {
            ...routineDefaults,
            name: "widen",
            identity: "public.widen(integer)",
            arguments: [
              {
                mode: "in",
                typeIdentity: "integer",
                databaseType: "integer",
                tsType: "number",
                default: "none",
              },
            ],
            result: {
              kind: "scalar",
              typeIdentity: "integer",
              databaseType: "integer",
              tsType: "number",
              nullable: false,
            },
          },
          {
            ...routineDefaults,
            name: "widen",
            identity: "public.widen(numeric)",
            arguments: [
              {
                mode: "in",
                typeIdentity: "numeric",
                databaseType: "numeric",
                tsType: "string",
                default: "none",
              },
            ],
            result: {
              kind: "scalar",
              typeIdentity: "numeric",
              databaseType: "numeric",
              tsType: "string",
              nullable: false,
            },
          },
        ],
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect(`
        SELECT same(1, 2) AS same_value,
               make_array2($1, 2.5) AS numeric_values,
               make_array2('a', 'b') AS labels,
               widen(1) AS widened,
               format_value('id') AS defaulted,
               format_value(value => $2, prefix => 'id') AS named,
               format_value('id', value => 2) AS mixed_notation,
               sum_many(1, 2.5) AS expanded_variadic,
               sum_many(VARIADIC ARRAY[1, 2]) AS explicit_variadic,
               sum_many() AS empty_variadic,
               sum_many(values => ARRAY[1]) AS named_variadic
      `),
      polymorphicSchema,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, tsType, databaseType }) => ({ name, tsType, databaseType })),
      [
        { name: "same_value", tsType: "number", databaseType: "integer" },
        { name: "numeric_values", tsType: "readonly (string)[]", databaseType: "numeric[]" },
        { name: "labels", tsType: "readonly (string)[]", databaseType: "text[]" },
        { name: "widened", tsType: "number", databaseType: "integer" },
        { name: "defaulted", tsType: "string", databaseType: "text" },
        { name: "named", tsType: "string", databaseType: "text" },
        { name: "mixed_notation", tsType: "string", databaseType: "text" },
        { name: "expanded_variadic", tsType: "string", databaseType: "numeric" },
        { name: "explicit_variadic", tsType: "string", databaseType: "numeric" },
        { name: "empty_variadic", tsType: "string", databaseType: "numeric" },
        { name: "named_variadic", tsType: "string", databaseType: "numeric" },
      ],
    );
    strict.deepStrictEqual(
      result.parameters.map(({ index, tsType, databaseType }) => ({ index, tsType, databaseType })),
      [
        { index: 1, tsType: "string", databaseType: "numeric" },
        { index: 2, tsType: "number", databaseType: "integer" },
      ],
    );
    strict.ok(
      resolveSelect(parseSelect("SELECT same(1, 2.5) AS invalid"), polymorphicSchema).diagnostics.some(
        ({ code }) => code === "TSQ202",
      ),
    );
    for (const invalid of [
      "SELECT format_value(value => 1) AS invalid",
      "SELECT format_value(prefix => 'x', prefix => 'y') AS invalid",
      "SELECT format_value(missing => 1, prefix => 'x') AS invalid",
      "SELECT format_value(VARIADIC ARRAY[1]) AS invalid",
      "SELECT sum_many(values => ARRAY[1], missing => 2) AS invalid",
    ]) {
      strict.ok(
        resolveSelect(parseSelect(invalid), polymorphicSchema).diagnostics.some(({ code }) => code === "TSQ202"),
        invalid,
      );
    }
  });

  await it("accepts the recursive keyword and fails ambiguous overloads safely", () => {
    const recursive = resolveStatement(
      parseStatement("WITH RECURSIVE n(value) AS (SELECT 1 AS value) SELECT value FROM n"),
      schema,
    );
    strict.deepStrictEqual(recursive.diagnostics, []);
    strict.strictEqual(recursive.columns[0]?.tsType, "number");
    const overloaded = resolveSelect(parseSelect("SELECT mystery($1) AS value"), {
      ...schema,
      functions: {
        "mystery(integer)": { name: "mystery", argumentTypes: ["integer"], returnType: "number", nullable: false },
        "mystery(text)": { name: "mystery", argumentTypes: ["text"], returnType: "string", nullable: false },
      },
    });
    strict.strictEqual(overloaded.diagnostics[0]?.code, "TSQ204");
    strict.strictEqual(overloaded.columns[0]?.tsType, "unknown");
  });
});
