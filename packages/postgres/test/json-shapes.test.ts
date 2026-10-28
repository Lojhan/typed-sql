import { describe, it, strict } from "poku";
import {
  decodeQueryResultRows,
  jsonShapeType,
  parameterTypeLiteral,
  rowTypeLiteral,
  sql,
  withQueryValuePlan,
} from "../../core/src/index.js";
import { type SchemaSnapshot, upgradeSchemaSnapshotV1 } from "../../schema/src/index.js";
import { postgresServerEvidence } from "../src/capabilities.js";
import { parseSelect, parseStatement } from "../src/parser/index.js";
import { resolveSelect, resolveStatement } from "../src/resolver.js";
import { defaultPostgresTypePolicy, type PostgresTypePolicy } from "../src/type-policy.js";

const schema = {
  formatVersion: 1,
  dialect: "postgres",
  tables: {
    accounts: {
      name: "accounts",
      columns: {
        id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
        name: { name: "name", databaseType: "text", tsType: "string", nullable: false },
        score: { name: "score", databaseType: "numeric", tsType: "string", nullable: true },
        ratio: { name: "ratio", databaseType: "double precision", tsType: "number", nullable: false },
        created: { name: "created", databaseType: "timestamptz", tsType: "Date", nullable: false },
        bytes: { name: "bytes", databaseType: "bytea", tsType: "Uint8Array", nullable: false },
        document: { name: "document", databaseType: "jsonb", tsType: "unknown", nullable: false },
        custom: { name: "custom", databaseType: "custom_type", tsType: "string", nullable: false },
      },
    },
  },
} as const satisfies SchemaSnapshot;

function analyze(source: string, typePolicy: PostgresTypePolicy = defaultPostgresTypePolicy) {
  return resolveSelect(parseSelect(source), schema, { typePolicy });
}

await describe("PostgreSQL constructed JSON shapes", async () => {
  await it("infers nested objects and aggregates using JSON serialization rather than scalar decoding", () => {
    const source = `SELECT jsonb_build_object(
      'id', a.id, 'created', a.created, 'bytes', a.bytes,
      'score', a.score, 'ratio', a.ratio, 'oid', 1::oid,
      'nested', json_build_object('name', a.name, 'null', NULL),
      'arbitrary', a.document, 'custom', a.custom
    ) AS document FROM accounts a WHERE a.id = $1`;
    const result = analyze(source, {
      ...defaultPostgresTypePolicy,
      bigint: "string",
      numeric: "Decimal",
      date: "string",
    });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(
      rowTypeLiteral(result.columns),
      '{ "document": { "id": number; "created": string; "bytes": string; "score": number | string | null; "ratio": number | string; "oid": string; "nested": { "name": string; "null": null; }; "arbitrary": unknown; "custom": unknown; }; }',
    );
    strict.deepStrictEqual(result.parameters, [
      { index: 1, tsType: "string", nullable: false, databaseType: "bigint" },
    ]);
    strict.strictEqual(
      source.slice(result.columns[0]!.range.start, result.columns[0]!.range.end).trim(),
      source.slice(7, source.indexOf(" FROM")).trim(),
    );
  });

  await it("retains SQL-null aggregate results and null elements across filtering, windows and outer joins", () => {
    const source = `SELECT json_agg(b.id) FILTER (WHERE b.id IS NOT NULL) AS ids,
      jsonb_agg(jsonb_build_object('id', b.id)) AS objects
      FROM accounts a LEFT JOIN accounts b ON a.id = b.id`;
    const result = analyze(source);
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(
      rowTypeLiteral(result.columns),
      '{ "ids": readonly (number | null)[] | null; "objects": readonly ({ "id": number | null; })[] | null; }',
    );
    const empty = analyze("SELECT json_agg(id) AS ids FROM accounts WHERE false");
    strict.strictEqual(rowTypeLiteral(empty.columns), '{ "ids": readonly (number)[] | null; }');
    const window = analyze("SELECT jsonb_agg(id) OVER (ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING) AS ids FROM accounts");
    strict.deepStrictEqual(window.diagnostics, []);
    strict.strictEqual(rowTypeLiteral(window.columns), '{ "ids": readonly (number)[] | null; }');
  });

  await it("preserves provenance across CTEs, derived tables, scalar subqueries and empty-array coalesce", () => {
    const source = `WITH objects AS (SELECT jsonb_build_object('id', id) AS item FROM accounts)
      SELECT jsonb_build_object('items', COALESCE(jsonb_agg(d.item), '[]'::jsonb),
        'one', (SELECT item FROM objects LIMIT 1)) AS document
      FROM (SELECT item FROM objects) d`;
    for (const json of ["unknown", "JsonValue", "string"] as const) {
      const result = analyze(source, { ...defaultPostgresTypePolicy, json });
      strict.deepStrictEqual(result.diagnostics, []);
      strict.strictEqual(
        rowTypeLiteral(result.columns),
        json === "string"
          ? '{ "document": string; }'
          : '{ "document": { "items": readonly ({ "id": number; })[]; "one": { "id": number; } | null; }; }',
      );
    }
  });

  await it("requires a concrete polymorphic aggregate input type and retains argument ranges", () => {
    for (const input of ["'literal'", "NULL", "$1"]) {
      const source = `SELECT json_agg(${input}) AS document`;
      const result = analyze(source);
      strict.strictEqual(result.columns[0]?.tsType, "unknown");
      strict.strictEqual(result.diagnostics[0]?.code, "TSQ202");
      const range = result.diagnostics[0]!.range;
      strict.strictEqual(source.slice(range.start, range.end), input);
    }
    const cast = analyze("SELECT json_agg('literal'::text) AS document");
    strict.deepStrictEqual(cast.diagnostics, []);
    strict.strictEqual(rowTypeLiteral(cast.columns), '{ "document": readonly (string)[] | null; }');
  });

  await it("keeps dynamic, variadic and ambiguous nontext keys conservative", () => {
    for (const call of [
      "jsonb_build_object(name, id)",
      "jsonb_build_object(1, id)",
      "jsonb_build_object(VARIADIC ARRAY['key', 'value'])",
    ]) {
      const result = analyze(`SELECT ${call} AS document FROM accounts`);
      strict.strictEqual(result.columns[0]?.tsType, "unknown", call);
    }
    const odd = analyze("SELECT json_build_object('id') AS document");
    strict.strictEqual(odd.diagnostics[0]?.code, "TSQ227");
    strict.strictEqual(odd.diagnostics[0]?.range.start, 7);
  });

  await it("clears JSON provenance for text casts, CASE and compound projections", () => {
    for (const value of [
      "jsonb_build_object('id', id)::text",
      "CASE WHEN true THEN jsonb_build_object('id', id) ELSE document END",
      "(SELECT jsonb_build_object('id', id) UNION ALL SELECT document)",
    ]) {
      const result = analyze(`SELECT jsonb_build_object('value', ${value}) AS document FROM accounts`);
      strict.deepStrictEqual(result.diagnostics, []);
      strict.strictEqual(
        rowTypeLiteral(result.columns),
        value.endsWith("::text") ? '{ "document": { "value": string; }; }' : '{ "document": { "value": unknown; }; }',
      );
    }
    const fallback = analyze(
      `SELECT COALESCE((SELECT jsonb_build_object('id', id) FROM accounts LIMIT 1), '[]'::jsonb) AS document`,
    );
    strict.strictEqual(rowTypeLiteral(fallback.columns), '{ "document": { "id": number; } | readonly []; }');
  });

  await it("does not apply builtin shapes to schema-qualified or quoted functions", () => {
    for (const name of ["public.jsonb_build_object", '"JSONB_BUILD_OBJECT"']) {
      const result = analyze(`SELECT ${name}('id', 1) AS document`);
      strict.strictEqual(result.columns[0]?.tsType, "unknown");
      strict.strictEqual(result.diagnostics[0]?.code, "TSQ202");
    }
    const customSchema = {
      ...schema,
      functions: {
        custom: {
          name: "jsonb_build_object",
          schema: "public",
          argumentTypes: ["text", "integer"],
          databaseReturnType: "text",
          returnType: "string",
          nullable: false,
        },
      },
    } as const satisfies SchemaSnapshot;
    for (const name of ["jsonb_build_object", "public.jsonb_build_object"]) {
      const custom = resolveSelect(parseSelect(`SELECT ${name}('id', 1) AS document`), customSchema);
      strict.deepStrictEqual(custom.diagnostics, []);
      strict.strictEqual(rowTypeLiteral(custom.columns), '{ "document": string; }');
    }
    const builtin = resolveSelect(
      parseSelect("SELECT pg_catalog.jsonb_build_object('id', 1) AS document"),
      customSchema,
    );
    strict.deepStrictEqual(builtin.diagnostics, []);
    strict.strictEqual(rowTypeLiteral(builtin.columns), '{ "document": { "id": number; }; }');
    const objectAggregate = analyze("SELECT jsonb_object_agg(name, id) AS document FROM accounts");
    strict.strictEqual(objectAggregate.columns[0]?.tsType, "{ [key: string]: number | undefined; }");
  });

  await it("unions possible JSON results from GREATEST and LEAST rather than retaining the first shape", () => {
    for (const name of ["GREATEST", "LEAST"]) {
      const result = analyze(`SELECT ${name}(jsonb_build_object('a', 1), jsonb_build_object('b', 'x')) AS document`);
      strict.deepStrictEqual(result.diagnostics, []);
      strict.strictEqual(rowTypeLiteral(result.columns), '{ "document": { "a": number; } | { "b": string; }; }');
    }
  });

  await it("models SQL-standard constructor null policies, FORMAT JSON and query arrays", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["JSON_OBJECT('a' VALUE score NULL ON NULL)", '{ "a": number | string | null; }'],
      ["JSON_OBJECT('a' VALUE score ABSENT ON NULL)", '{ "a"?: number | string; }'],
      ["JSON_OBJECT('a' VALUE NULL ABSENT ON NULL)", "{ }"],
      ["JSON_OBJECT('a' VALUE 1, 'a' VALUE name ABSENT ON NULL)", '{ "a": number | string; }'],
      ["JSON_OBJECT('nested' VALUE '{\"id\":1}' FORMAT JSON RETURNING jsonb)", '{ "nested": { "id": 1; }; }'],
      ["JSON_ARRAY(1,NULL ABSENT ON NULL)", "readonly [number]"],
      ["JSON_ARRAY(1,NULL NULL ON NULL)", "readonly [number, null]"],
      ["JSON_ARRAY(score ABSENT ON NULL)", "readonly (number | string)[]"],
      ["JSON_ARRAY(score NULL ON NULL)", "readonly [number | string | null]"],
      ["JSON_ARRAY(SELECT id FROM accounts)", "readonly (number)[]"],
      ["JSON_ARRAY('{\"id\":1}' FORMAT JSON RETURNING jsonb)", 'readonly [{ "id": 1; }]'],
      ["JSON_ARRAYAGG(score ABSENT ON NULL)", "readonly (number | string)[]"],
      ["JSON_ARRAYAGG(score NULL ON NULL)", "readonly (number | string | null)[]"],
      ["JSON_OBJECTAGG(name VALUE score NULL ON NULL)", "{ [key: string]: number | string | null | undefined; }"],
    ];
    for (const [expression, type] of cases) {
      const result = resolveSelect(parseSelect(`SELECT ${expression} AS value FROM accounts`), {
        ...upgradeSchemaSnapshotV1(schema),
        server: postgresServerEvidence("18.6", [], { standardConformingStrings: "on" }),
      });
      strict.deepStrictEqual(result.diagnostics, [], expression);
      strict.strictEqual(result.columns[0]?.tsType, type, expression);
    }
  });

  await it("preserves JSON input declarations under text policy and marks FORMAT JSON document positions", () => {
    const shape = { kind: "object", properties: { id: { shape: { kind: "number" } } } } as const;
    const declared = {
      ...schema,
      tables: {
        ...schema.tables,
        accounts: {
          ...schema.tables.accounts,
          columns: {
            ...schema.tables.accounts.columns,
            document: { ...schema.tables.accounts.columns.document, jsonDeclaration: { source: "database", shape } },
          },
        },
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveStatement(parseStatement("INSERT INTO accounts(document) VALUES ($1)"), declared, {
      typePolicy: { ...defaultPostgresTypePolicy, json: "string" },
    });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(result.parameters, [
      {
        index: 1,
        tsType: "string",
        nullable: false,
        databaseType: "jsonb",
        json: { shape, representation: "text" },
        acceptsJsonInput: true,
      },
    ]);
    strict.strictEqual(
      parameterTypeLiteral(1, result.parameters),
      'readonly [string | import("@typed-sql/core").JsonInput<{ "id": number; }>]',
    );
    const format = resolveSelect(parseSelect("SELECT JSON_ARRAY($1 FORMAT JSON RETURNING jsonb) AS value"), {
      ...upgradeSchemaSnapshotV1(schema),
      server: postgresServerEvidence("18.6", [], { standardConformingStrings: "on" }),
    });
    strict.deepStrictEqual(format.diagnostics, []);
    strict.strictEqual(format.parameters[0]?.acceptsJsonInput, true);
    strict.strictEqual(format.parameters[0]?.databaseType, "text");
    const value = analyze("SELECT jsonb_build_object('value', $1) AS value");
    strict.deepStrictEqual(value.diagnostics, []);
    strict.strictEqual(value.parameters[0]?.acceptsJsonInput, undefined);
    const cast = analyze("SELECT $1::jsonb AS value");
    strict.deepStrictEqual(cast.diagnostics, []);
    strict.strictEqual(cast.parameters[0]?.json?.shape.kind, "unknown");
    strict.strictEqual(cast.parameters[0]?.acceptsJsonInput, true);
  });

  await it("validates structured JSON elements in native ARRAY projections, unions and aggregates", () => {
    const shape = { kind: "object", properties: { id: { shape: { kind: "number" } } } } as const;
    const declared = {
      ...schema,
      tables: {
        ...schema.tables,
        accounts: {
          ...schema.tables.accounts,
          columns: {
            ...schema.tables.accounts.columns,
            document: { ...schema.tables.accounts.columns.document, jsonDeclaration: { source: "application", shape } },
          },
        },
      },
    } as const satisfies SchemaSnapshot;
    for (const source of [
      "SELECT ARRAY[document] AS value FROM accounts",
      "WITH docs AS (SELECT ARRAY[document] AS items FROM accounts) SELECT items AS value FROM docs",
      "SELECT CASE WHEN true THEN ARRAY[document] ELSE ARRAY[document] END AS value FROM accounts",
      "SELECT COALESCE(ARRAY[document],ARRAY[document]) AS value FROM accounts",
      "SELECT ARRAY_AGG(document) AS value FROM accounts",
      "SELECT ARRAY[document] AS value FROM accounts UNION ALL SELECT ARRAY[document] AS value FROM accounts",
      "SELECT GREATEST(ARRAY[document],ARRAY[document]) AS value FROM accounts",
      "SELECT LAG(ARRAY[document],1,ARRAY[document]) OVER () AS value FROM accounts",
    ]) {
      const result = resolveSelect(parseSelect(source), declared, { runtimeValidation: true });
      strict.deepStrictEqual(result.diagnostics, [], source);
      strict.deepStrictEqual(result.parameters, [], source);
      strict.ok(result.columns[0]?.tsType.includes('{ "id": number; }'), source);
      const column = result.columns[0]!;
      strict.ok(column.runtimeType, source);
      const query = withQueryValuePlan(sql`SELECT 1`, {
        dialect: "postgres",
        typePolicyHash: "test",
        columns: [{ name: "value", nullable: column.nullable, type: column.runtimeType! }],
        parameters: [],
      });
      const profile = { id: "json-array", dialect: "postgres", integer: "lossless", jsonWire: "text" } as const;
      strict.deepStrictEqual(
        decodeQueryResultRows(query, [{ value: ['{"id":1}'] }], profile),
        [{ value: [{ id: 1 }] }],
        source,
      );
      strict.throws(() => decodeQueryResultRows(query, [{ value: ['{"id":"wrong"}'] }], profile), /JSON|union/, source);
    }
    const unchecked = resolveSelect(parseSelect("SELECT ARRAY[document] AS value FROM accounts"), declared);
    strict.strictEqual(unchecked.columns[0]?.tsType, "readonly (unknown)[]");
    strict.deepStrictEqual(unchecked.columns[0]?.runtimeType, {
      array: { json: { shape: { kind: "unknown" }, representation: "parsed" } },
      elementNullable: false,
    });
  });

  await it("keeps SQL NULL array elements separate from JSON document shapes", () => {
    const shape = { kind: "object", properties: { id: { shape: { kind: "number" } } } } as const;
    const declared = {
      ...schema,
      tables: {
        ...schema.tables,
        accounts: {
          ...schema.tables.accounts,
          columns: {
            ...schema.tables.accounts.columns,
            document: {
              ...schema.tables.accounts.columns.document,
              nullable: true,
              jsonDeclaration: { source: "application", shape },
            },
          },
        },
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(parseSelect("SELECT ARRAY[document] AS value FROM accounts"), declared, {
      runtimeValidation: true,
    });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(result.columns[0]?.tsType, 'readonly ({ "id": number; } | null)[]');
    const query = withQueryValuePlan(sql`SELECT 1`, {
      dialect: "postgres",
      typePolicyHash: "test",
      columns: [{ name: "value", nullable: false, type: result.columns[0]!.runtimeType! }],
      parameters: [],
    });
    const profile = { id: "nullable-json-array", dialect: "postgres", integer: "lossless", jsonWire: "text" } as const;
    strict.deepStrictEqual(decodeQueryResultRows(query, [{ value: [null, '{"id":1}'] }], profile), [
      { value: [null, { id: 1 }] },
    ]);
    strict.throws(() => decodeQueryResultRows(query, [{ value: ["null"] }], profile), /JSON/);
  });

  await it("marks opaque JSON and JSON array output datatypes for policy-correct planned decoding", () => {
    const bare = analyze("SELECT document AS value FROM accounts");
    strict.strictEqual(bare.columns[0]?.tsType, "unknown");
    strict.deepStrictEqual(bare.columns[0]?.json, { shape: { kind: "unknown" }, representation: "parsed" });
    const text = analyze("SELECT document AS value FROM accounts", { ...defaultPostgresTypePolicy, json: "string" });
    strict.deepStrictEqual(text.columns[0]?.json, { shape: { kind: "unknown" }, representation: "text" });
    const arrays = {
      ...schema,
      tables: {
        ...schema.tables,
        accounts: {
          ...schema.tables.accounts,
          columns: {
            ...schema.tables.accounts.columns,
            documents: { name: "documents", databaseType: "jsonb[]", tsType: "readonly unknown[]", nullable: false },
          },
        },
      },
    } as const satisfies SchemaSnapshot;
    const array = resolveSelect(parseSelect("SELECT documents AS value FROM accounts"), arrays);
    strict.deepStrictEqual(array.diagnostics, []);
    strict.deepStrictEqual(array.columns[0]?.runtimeType, {
      array: { json: { shape: { kind: "unknown" }, representation: "parsed" } },
      elementNullable: true,
    });
  });

  await it("widens opaque JSON snapshot types before inheriting them into native arrays", () => {
    const opaque = {
      ...schema,
      tables: {
        ...schema.tables,
        accounts: {
          ...schema.tables.accounts,
          columns: {
            ...schema.tables.accounts.columns,
            document: { ...schema.tables.accounts.columns.document, tsType: "{ id: number }" },
            documents: {
              name: "documents",
              databaseType: "jsonb[]",
              tsType: "readonly { id: number }[]",
              nullable: false,
            },
          },
        },
      },
    } as const satisfies SchemaSnapshot;
    for (const [source, type] of [
      ["SELECT document AS value FROM accounts", "unknown"],
      ["SELECT documents AS value FROM accounts", "readonly (unknown | null)[]"],
      ["SELECT ARRAY[document] AS value FROM accounts", "readonly (unknown)[]"],
      ["SELECT ARRAY_AGG(document) AS value FROM accounts", "readonly (unknown)[]"],
    ] as const) {
      const result = resolveSelect(parseSelect(source), opaque, { runtimeValidation: true });
      strict.deepStrictEqual(result.diagnostics, [], source);
      strict.strictEqual(result.columns[0]?.tsType, type, source);
    }
    for (const json of ["JsonValue", "string"] as const) {
      const result = resolveSelect(parseSelect("SELECT document AS value FROM accounts"), opaque, {
        typePolicy: { ...defaultPostgresTypePolicy, json },
      });
      strict.strictEqual(result.columns[0]?.tsType, json);
    }
  });

  await it("merges SQL-null-only JSON branches without losing application shape validation", () => {
    const shape = { kind: "object", properties: { id: { shape: { kind: "number" } } } } as const;
    const declared = {
      ...schema,
      tables: {
        ...schema.tables,
        accounts: {
          ...schema.tables.accounts,
          columns: {
            ...schema.tables.accounts.columns,
            document: { ...schema.tables.accounts.columns.document, jsonDeclaration: { source: "application", shape } },
          },
        },
      },
    } as const satisfies SchemaSnapshot;
    for (const source of [
      "SELECT '{}'::jsonb->'missing' AS value UNION ALL SELECT document AS value FROM accounts",
      "SELECT document AS value FROM accounts UNION ALL SELECT '{}'::jsonb->'missing' AS value",
      "SELECT CASE WHEN true THEN '{}'::jsonb->'missing' ELSE document END AS value FROM accounts",
      "SELECT COALESCE('{}'::jsonb->'missing',document) AS value FROM accounts",
    ]) {
      const result = resolveSelect(parseSelect(source), declared, { runtimeValidation: true });
      strict.deepStrictEqual(result.diagnostics, [], source);
      strict.strictEqual(result.columns[0]?.tsType, '{ "id": number; }', source);
      strict.strictEqual(result.columns[0]?.scalarJsonShape, undefined, source);
      strict.deepStrictEqual(
        result.columns[0]?.json,
        { shape, representation: "parsed", requiresRuntimeValidation: true },
        source,
      );
      const query = withQueryValuePlan(sql`SELECT 1`, {
        dialect: "postgres",
        typePolicyHash: "test",
        columns: [
          { name: "value", type: "unknown", nullable: result.columns[0]!.nullable, json: result.columns[0]!.json! },
        ],
        parameters: [],
      });
      const profile = {
        id: "nullable-json-branches",
        dialect: "postgres",
        integer: "lossless",
        jsonWire: "text",
      } as const;
      strict.deepStrictEqual(
        decodeQueryResultRows(
          query,
          [...(result.columns[0]!.nullable ? [{ value: null }] : []), { value: '{"id":1}' }],
          profile,
        ),
        [...(result.columns[0]!.nullable ? [{ value: null }] : []), { value: { id: 1 } }],
        source,
      );
      strict.throws(() => decodeQueryResultRows(query, [{ value: '{"id":"wrong"}' }], profile), /JSON/, source);
    }
    const both = analyze("SELECT '{}'::jsonb->'x' AS value UNION ALL SELECT '{}'::jsonb->'y' AS value");
    strict.deepStrictEqual(both.diagnostics, []);
    strict.strictEqual(both.columns[0]?.tsType, "never");
    strict.deepStrictEqual(both.columns[0]?.scalarJsonShape, { kind: "null" });
    strict.strictEqual(both.columns[0]?.json, undefined);
  });

  await it("retains null-only runtime guards for statically missing and JSON-null text paths", () => {
    for (const expression of ["'[1,2]'::jsonb -> '0'", "'{\"x\":null}'::jsonb ->> 'x'"]) {
      const result = analyze(`SELECT ${expression} AS value`);
      strict.deepStrictEqual(result.diagnostics, []);
      strict.strictEqual(result.columns[0]?.tsType, "never");
      strict.strictEqual(result.columns[0]?.nullable, true);
      strict.deepStrictEqual(result.columns[0]?.scalarJsonShape, { kind: "null" });
    }
  });

  await it("publishes structured descriptors for arrays, conversions, paths and immutable JSONB updates", () => {
    const cases: readonly (readonly [string, string, boolean])[] = [
      ["jsonb_build_array(1, true, 'x', NULL)", "readonly [number, boolean, string, null]", false],
      ["row_to_json(ROW(1, 'x'))", '{ "f1": number; "f2": string; }', false],
      ["to_jsonb(ARRAY[1, 2])", "readonly [number, number]", false],
      ["json_build_object('id', id, 'id', name)", '{ "id": string; }', false],
      ["'{\"items\":[{\"id\":1},null]}'::jsonb #> '{items,0,id}'", "1", false],
      ["'[1,2]'::jsonb -> 0", "1", false],
      ["'[1,2]'::jsonb -> '0'", "never", true],
      ["'{\"x\":null}'::jsonb -> 'x'", "null", false],
      ["'{\"x\":null}'::jsonb ->> 'x'", "never", true],
      ["jsonb_extract_path('{\"x\":[1,2]}'::jsonb, 'x', '1')", "2", false],
      ["json_extract_path_text('{\"x\":true}'::json, 'x')", "string", false],
      ["jsonb_set('{\"a\":[1,2]}'::jsonb, '{a,9}', 'true'::jsonb)", '{ "a": readonly [1, 2, true]; }', false],
      ["jsonb_set('[1,2]'::jsonb, '{-9}', 'true'::jsonb)", "readonly [true, 1, 2]", false],
      ["jsonb_set('{\"a\":1}'::jsonb, '{missing}', 'true'::jsonb, false)", '{ "a": 1; }', false],
      ["jsonb_insert('[1,2]'::jsonb, '{0}', 'true'::jsonb)", "readonly [true, 1, 2]", false],
      ["jsonb_insert('[1,2]'::jsonb, '{0}', 'true'::jsonb, true)", "readonly [1, true, 2]", false],
      ['\'{"a":1}\'::jsonb || \'{"a":true,"b":2}\'::jsonb', '{ "a": true; "b": 2; }', false],
      ["'[1]'::jsonb || '[true]'::jsonb", "readonly [1, true]", false],
      ["'{\"a\":1,\"b\":2}'::jsonb #- '{a}'", '{ "b": 2; }', false],
      ["'{\"a\":1,\"b\":2}'::jsonb - 'a'", '{ "b": 2; }', false],
      ["'[1,2]'::jsonb - 0", "readonly [2]", false],
      ['\'["a","b","a",1]\'::jsonb - \'a\'', 'readonly ["b", 1]', false],
      ["'{\"a\":1,\"b\":2,\"c\":3}'::jsonb - ARRAY['a','b']", '{ "c": 3; }', false],
    ];
    for (const [expression, expected, nullable] of cases) {
      const result = analyze(`SELECT ${expression} AS value FROM accounts`);
      strict.deepStrictEqual(result.diagnostics, [], expression);
      strict.strictEqual(result.columns[0]?.tsType, expected, expression);
      strict.strictEqual(result.columns[0]?.nullable, nullable, expression);
      if (result.columns[0]?.json !== undefined) {
        strict.strictEqual(result.columns[0].json.representation, "parsed");
        strict.strictEqual(jsonShapeType(result.columns[0].json.shape), expected);
      }
    }
    for (const input of ["to_json('unknown')", "to_jsonb(NULL)", "row_to_json(1)", "array_to_json(1)"]) {
      const result = analyze(`SELECT ${input} AS value`);
      strict.strictEqual(result.columns[0]?.tsType, "unknown");
      strict.strictEqual(result.diagnostics[0]?.code, "TSQ202");
    }
  });

  await it("preserves declared JSON shape evidence through projected columns and whole-row conversion", () => {
    const declared = {
      ...schema,
      tables: {
        ...schema.tables,
        accounts: {
          ...schema.tables.accounts,
          columns: {
            ...schema.tables.accounts.columns,
            document: {
              ...schema.tables.accounts.columns.document,
              jsonDeclaration: {
                source: "application",
                shape: { kind: "object", properties: { id: { shape: { kind: "number" } } } },
              },
            },
          },
        },
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(
      parseSelect("WITH selected AS (SELECT document FROM accounts) SELECT document -> 'id' AS value FROM selected"),
      declared,
      { runtimeValidation: true },
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(result.columns[0]?.tsType, "number");
    strict.strictEqual(result.columns[0]?.json?.shape.kind, "number");
    strict.strictEqual(result.columns[0]?.json?.requiresRuntimeValidation, true);
    const untrusted = resolveSelect(parseSelect("SELECT document -> 'id' AS value FROM accounts"), declared);
    strict.strictEqual(untrusted.columns[0]?.tsType, "unknown");
    strict.strictEqual(untrusted.columns[0]?.nullable, true);
    const databaseDeclared = {
      ...declared,
      tables: {
        ...declared.tables,
        accounts: {
          ...declared.tables.accounts,
          columns: {
            ...declared.tables.accounts.columns,
            document: {
              ...declared.tables.accounts.columns.document,
              jsonDeclaration: { ...declared.tables.accounts.columns.document.jsonDeclaration, source: "database" },
            },
          },
        },
      },
    } as const;
    strict.strictEqual(
      resolveSelect(parseSelect("SELECT document -> 'id' AS value FROM accounts"), databaseDeclared).columns[0]?.tsType,
      "number",
    );
    const row = analyze("SELECT to_jsonb(a) AS value FROM accounts a");
    strict.deepStrictEqual(row.diagnostics, []);
    strict.ok(row.columns[0]?.tsType.includes('"id": number'));
  });

  await it("does not promise a rank for JSON conversion of a stored PostgreSQL array", () => {
    const stored = {
      ...schema,
      tables: {
        items: {
          name: "items",
          columns: {
            values: { name: "values", databaseType: "integer[]", tsType: "readonly (number)[]", nullable: false },
          },
        },
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(parseSelect("SELECT to_json(values) AS value FROM items"), stored);
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(result.columns[0]?.tsType, "unknown");
    strict.strictEqual(
      resolveSelect(parseSelect("SELECT values FROM items"), stored).columns[0]?.tsType,
      "readonly (number | null)[]",
    );
  });

  await it("keeps dynamic paths, flags and unknown source JSON conservative", () => {
    for (const expression of [
      "document -> $1::text",
      "document #> $1::text[]",
      "jsonb_set(document, '{id}', '1'::jsonb)",
      "jsonb_set('{\"id\":1}'::jsonb, $1::text[], 'true'::jsonb)",
      "jsonb_set('{\"id\":1}'::jsonb, '{id}', 'true'::jsonb, $1::boolean)",
      "jsonb_extract_path(document, $1::text)",
    ]) {
      const result = analyze(`SELECT ${expression} AS value FROM accounts`);
      strict.deepStrictEqual(result.diagnostics, [], expression);
      strict.strictEqual(result.columns[0]?.tsType, "unknown", expression);
    }
    const invalid = analyze("SELECT '{not-json}'::jsonb AS value");
    strict.strictEqual(invalid.diagnostics[0]?.code, "TSQ203");
    strict.strictEqual(analyze("SELECT to_json(1, 2) AS value").diagnostics[0]?.code, "TSQ227");
    const input = analyze("SELECT jsonb_set('[1,2]'::jsonb, '{9}', 'true'::jsonb, false) AS value");
    strict.strictEqual(input.columns[0]?.tsType, "readonly [1, 2]");
  });

  await it("bounds repeated projection expansion before constructing exponentially growing types", () => {
    const ctes = ["a0 AS (SELECT jsonb_build_object('id', 1) AS item)"];
    for (let i = 1; i <= 25; i++)
      ctes.push(`a${i} AS (SELECT jsonb_build_object('l', item, 'r', item) AS item FROM a${i - 1})`);
    const result = analyze(`WITH ${ctes.join(", ")} SELECT item FROM a25`);
    strict.deepStrictEqual(result.diagnostics, []);
    strict.ok(result.columns[0]!.tsType.length <= 16_384);
    strict.ok(result.columns[0]!.tsType.includes("unknown"));
  });
});
