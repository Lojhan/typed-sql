import { describe, it, strict } from "poku";
import { type JsonShape, jsonShapeType, validateJsonValue } from "../../core/src/index.js";
import type { SchemaSnapshot } from "../../schema/src/index.js";
import { parseSelect } from "../src/parser/index.js";
import { resolveMySqlStatement } from "../src/resolver.js";
import { defaultMySqlTypePolicy } from "../src/type-policy.js";

const schema = {
  formatVersion: 1,
  dialect: "mysql",
  tables: {
    accounts: {
      name: "accounts",
      columns: {
        id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
        active: { name: "active", databaseType: "tinyint(1)", tsType: "boolean", nullable: false },
        amount: { name: "amount", databaseType: "decimal(14,2)", tsType: "string", nullable: false },
        created: { name: "created", databaseType: "datetime", tsType: "Date", nullable: true },
        document: { name: "document", databaseType: "json", tsType: "unknown", nullable: false },
      },
    },
  },
} as const satisfies SchemaSnapshot;
const analyze = (source: string) => resolveMySqlStatement(parseSelect(source), schema);

await describe("MySQL structured JSON", async () => {
  await it("uses JSON serialization independently of scalar bigint, decimal, date and tinyint policies", () => {
    const result = analyze(
      "SELECT JSON_OBJECT('id', id, 'active', active, 'amount', amount, 'created', created, 'opaque', document, 'nested', JSON_ARRAY(TRUE, NULL)) AS result FROM accounts WHERE id = ?",
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(
      result.columns[0]?.tsType,
      '{ "id": number; "active": number; "amount": number; "created": string | null; "opaque": unknown; "nested": readonly [boolean, null]; }',
    );
    strict.deepStrictEqual(result.parameters, [
      { index: 1, tsType: "bigint", nullable: false, databaseType: "bigint" },
    ]);
    strict.strictEqual(result.columns[0]?.json?.representation, "parsed");
  });

  await it("infers empty constructors, duplicate keys, arrays and nullable aggregates", () => {
    const cases: readonly (readonly [string, string, boolean])[] = [
      ["JSON_OBJECT()", "{ }", false],
      ["JSON_ARRAY()", "readonly []", false],
      ["JSON_OBJECT('id', 1, 'id', 'last')", '{ "id": string; }', false],
      ["JSON_ARRAYAGG(id)", "readonly (number)[]", true],
      ["JSON_OBJECTAGG('id', id)", "{ [key: string]: number | undefined; }", true],
      ["JSON_OBJECT('value', JSON_ARRAYAGG(id))", '{ "value": readonly (number)[] | null; }', false],
    ];
    for (const [expression, type, nullable] of cases) {
      const result = analyze(`SELECT ${expression} AS result FROM accounts`);
      strict.deepStrictEqual(result.diagnostics, [], expression);
      strict.strictEqual(result.columns[0]?.tsType, type, expression);
      strict.strictEqual(result.columns[0]?.nullable, nullable, expression);
    }
  });

  await it("retains native JSON through projections and unions while treating quoted JSON text as a string VALUE", () => {
    const projected = analyze(
      "WITH items AS (SELECT JSON_OBJECT('id', id) AS item FROM accounts) SELECT JSON_ARRAY(item) AS result FROM (SELECT item FROM items) d",
    );
    strict.deepStrictEqual(projected.diagnostics, []);
    strict.strictEqual(projected.columns[0]?.tsType, 'readonly [{ "id": number; }]');
    const union = analyze("SELECT JSON_OBJECT('a', 1) AS result UNION ALL SELECT JSON_OBJECT('b', 'x')");
    strict.deepStrictEqual(union.diagnostics, []);
    strict.strictEqual(union.columns[0]?.tsType, '{ "a": number; } | { "b": string; }');
    const quoted = analyze("SELECT JSON_OBJECT('value', JSON_QUOTE('text')) AS result");
    strict.strictEqual(quoted.columns[0]?.tsType, '{ "value": string; }');
    strict.strictEqual(analyze("SELECT IFNULL(CAST(NULL AS JSON), 1) AS result").columns[0]?.tsType, "unknown");
  });

  await it("implements literal path indexing, MySQL autowrap and JSON null distinct from missing SQL null", () => {
    const cases: readonly (readonly [string, string, boolean])[] = [
      ["JSON_EXTRACT('{\"a\":1}', '$[0].a')", "1", false],
      ["JSON_EXTRACT('{\"a\":[true,null]}', '$.a[0]')", "true", false],
      ["JSON_EXTRACT('{\"a\":[true,null]}', '$.a[last]')", "null", false],
      ["JSON_EXTRACT('{\"a\":1}', '$.missing')", "unknown", true],
      ["JSON_EXTRACT('{\"a\":1}', '$.missing', '$.a')", "readonly [1]", false],
      ["JSON_UNQUOTE(JSON_EXTRACT('{\"a\":null}', '$.a'))", "string", false],
      ["JSON_VALUE('{\"a\":1}', '$.a')", "string", true],
    ];
    for (const [expression, type, nullable] of cases) {
      const result = analyze(`SELECT ${expression} AS result`);
      strict.deepStrictEqual(result.diagnostics, [], expression);
      strict.strictEqual(result.columns[0]?.tsType, type, expression);
      strict.strictEqual(result.columns[0]?.nullable, nullable, expression);
    }
  });

  await it("clears JSON provenance when unary minus coerces a JSON operand to SQL double", () => {
    const result = analyze(
      `SELECT -JSON_OBJECT('a',1) AS object_number, -JSON_EXTRACT('[1]', '$[0]') AS scalar_number, +JSON_OBJECT('a',1) AS preserved`,
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.slice(0, 2).map(({ tsType, databaseType, json }) => ({ tsType, databaseType, json })),
      [
        { tsType: "number", databaseType: "double", json: undefined },
        { tsType: "number", databaseType: "double", json: undefined },
      ],
    );
    strict.strictEqual(result.columns[2]?.tsType, '{ "a": number; }');
  });

  await it("does not overwrite an existing document root in JSON_INSERT", () => {
    const result = analyze(`SELECT JSON_INSERT('{"a":1}', '$', 2) AS result`);
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(result.columns[0]?.tsType, '{ "a": 1; }');
    strict.ok(validateJsonValue({ a: 1 }, result.columns[0]!.json!.shape));
    strict.strictEqual(validateJsonValue(2, result.columns[0]!.json!.shape), false);
  });

  await it("describes static object/array mutations and preserves optional merge-patch branches", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["JSON_SET('{\"a\":[1,2]}', '$.a[9]', TRUE)", '{ "a": readonly [1, 2, boolean]; }'],
      ["JSON_SET('{\"a\":1}', '$[1]', 2)", 'readonly [{ "a": 1; }, number]'],
      ["JSON_INSERT('{\"a\":1}', '$.a', 'x')", '{ "a": 1; }'],
      ["JSON_REPLACE('{\"a\":1}', '$.missing', 'x')", '{ "a": 1; }'],
      ["JSON_REMOVE('{\"a\":1,\"b\":2}', '$[0].a')", '{ "b": 2; }'],
      ['JSON_MERGE_PATCH(\'{"a":1}\', \'{"a":null,"b":true}\')', '{ "b": true; }'],
    ];
    for (const [expression, type] of cases) {
      const result = analyze(`SELECT ${expression} AS result`);
      strict.deepStrictEqual(result.diagnostics, [], expression);
      strict.strictEqual(result.columns[0]?.tsType, type, expression);
    }
    const patch: JsonShape = { kind: "object", properties: { a: { shape: { kind: "string" }, optional: true } } };
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
              jsonDeclaration: { source: "database", shape: patch },
            },
          },
        },
      },
    } as const satisfies SchemaSnapshot;
    const merged = resolveMySqlStatement(
      parseSelect("SELECT JSON_MERGE_PATCH('{}', document) AS result FROM accounts"),
      declared,
    );
    strict.deepStrictEqual(merged.diagnostics, []);
    const shape = merged.columns[0]!.json!.shape;
    strict.strictEqual(validateJsonValue({}, shape), true);
    strict.strictEqual(validateJsonValue({ a: "x" }, shape), true);
  });

  await it("preserves append, insertion and recursive merge JSON semantics", () => {
    const cases: readonly (readonly [string, unknown])[] = [
      [`JSON_ARRAY_APPEND('{"a":[1]}', '$.a', 2)`, { a: [1, 2] }],
      [`JSON_ARRAY_APPEND('{"a":1}', '$[0].a', 2)`, { a: [1, 2] }],
      [`JSON_ARRAY_APPEND('{}', '$.a', 2)`, {}],
      [`JSON_ARRAY_INSERT('[1,2]', '$[last]', 3)`, [1, 3, 2]],
      [`JSON_ARRAY_INSERT('[1,2]', '$[last-10]', 3)`, [3, 1, 2]],
      [`JSON_ARRAY_INSERT('[1,2]', '$[9]', 3)`, [1, 2, 3]],
      [`JSON_ARRAY_INSERT('{"a":1}', '$[0]', 2)`, { a: 1 }],
      [`JSON_MERGE_PRESERVE('{"a":1}', '{"a":2}')`, { a: [1, 2] }],
      [`JSON_MERGE_PRESERVE('{"a":{"b":1}}', '{"a":{"c":2}}')`, { a: { b: 1, c: 2 } }],
      [`JSON_MERGE_PRESERVE('[1,2]', '[3]')`, [1, 2, 3]],
      [`JSON_MERGE_PRESERVE('1', '{"a":2}')`, [1, { a: 2 }]],
    ];
    for (const [expression, nativeValue] of cases) {
      const result = analyze(`SELECT ${expression} AS result`);
      strict.deepStrictEqual(result.diagnostics, [], expression);
      strict.deepStrictEqual(result.parameters, [], expression);
      strict.strictEqual(result.columns[0]?.nullable, false, expression);
      strict.ok(validateJsonValue(nativeValue, result.columns[0]!.json!.shape), expression);
    }
    strict.strictEqual(
      analyze(`SELECT JSON_ARRAY_INSERT('[1,2]', '$[last]', 3) AS result`).columns[0]?.tsType,
      "readonly [1, number, 2]",
    );
    strict.strictEqual(
      analyze(`SELECT JSON_MERGE_PRESERVE('{"a":1}', '{"a":2}') AS result`).columns[0]?.tsType,
      '{ "a": readonly [1, 2]; }',
    );
  });

  await it("fails closed for dynamic paths, invalid document literals and unsupported call forms", () => {
    for (const expression of [
      "JSON_EXTRACT(document, ?)",
      "JSON_SET(document, ?, 1)",
      "JSON_ARRAY_APPEND(document, ?, 1)",
      "JSON_REMOVE(document, '$')",
      "JSON_EXTRACT(document, '$.*')",
      "JSON_EXTRACT(document, '$.a[bad]')",
      "JSON_OBJECT(id, 1)",
      "JSON_MERGE_PRESERVE(document, JSON_OBJECT())",
    ]) {
      const result = analyze(`SELECT ${expression} AS result FROM accounts`);
      strict.deepStrictEqual(result.diagnostics, [], expression);
      strict.ok(result.columns[0]?.json, expression);
      strict.ok(validateJsonValue({ arbitrary: [1, null] }, result.columns[0]!.json!.shape), expression);
    }
    for (const expression of [
      "JSON_OBJECT('a')",
      "JSON_EXTRACT()",
      "JSON_ARRAYAGG()",
      "JSON_QUOTE()",
      "JSON_SET('{}')",
      "JSON_REMOVE('{}')",
      "JSON_MERGE_PATCH('{}')",
      "JSON_MERGE_PRESERVE('{}')",
      "JSON_ARRAY_INSERT('{}')",
    ]) {
      const source = `SELECT ${expression} AS result`;
      const result = analyze(source);
      strict.ok(result.diagnostics.length > 0, expression);
      strict.ok(
        result.diagnostics.every((diagnostic) => diagnostic.range.start >= 0 && diagnostic.range.end <= source.length),
        expression,
      );
    }
    const invalid = analyze(`SELECT JSON_EXTRACT('invalid', '$.x') AS result`);
    strict.ok(invalid.diagnostics.some((diagnostic) => diagnostic.code === "TSQ203"));
  });

  await it("handles optional, open, union and runtime-sized array declarations conservatively during mutations", () => {
    const shapes: readonly JsonShape[] = [
      {
        kind: "object",
        properties: {
          a: { shape: { kind: "object", properties: { x: { shape: { kind: "number" } } } }, optional: true },
        },
      },
      { kind: "object", properties: {}, additionalProperties: { kind: "array", element: { kind: "number" } } },
      {
        kind: "union",
        variants: [
          { kind: "object", properties: { a: { shape: { kind: "number" } } } },
          { kind: "tuple", elements: [{ kind: "number" }] },
        ],
      },
      { kind: "array", element: { kind: "number" } },
    ];
    for (const shape of shapes) {
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
      for (const expression of [
        "JSON_EXTRACT(document, '$[0]')",
        "JSON_SET(document, '$.a.x', 1)",
        "JSON_INSERT(document, '$[2]', 1)",
        "JSON_REPLACE(document, '$[0]', 1)",
        "JSON_REMOVE(document, '$[last]')",
        "JSON_ARRAY_APPEND(document, '$[0]', 1)",
        "JSON_ARRAY_INSERT(document, '$[0]', 1)",
        "JSON_MERGE_PATCH(document, document)",
        "JSON_MERGE_PRESERVE(document, document)",
      ]) {
        const result = resolveMySqlStatement(parseSelect(`SELECT ${expression} AS result FROM accounts`), declared);
        strict.deepStrictEqual(result.diagnostics, [], expression);
        strict.ok(result.columns[0]?.json, expression);
      }
    }
  });

  await it("requires runtime-backed context before narrowing application JSON declarations", () => {
    const shape: JsonShape = { kind: "object", properties: { id: { shape: { kind: "number" } } } };
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
    const source = parseSelect("SELECT JSON_EXTRACT(document, '$.id') AS result FROM accounts");
    strict.strictEqual(resolveMySqlStatement(source, declared).columns[0]?.tsType, "unknown");
    const checked = resolveMySqlStatement(source, declared, { runtimeValidation: true });
    strict.strictEqual(checked.columns[0]?.tsType, "number");
    strict.strictEqual(checked.columns[0]?.json?.requiresRuntimeValidation, true);
    const text = resolveMySqlStatement(source, declared, {
      runtimeValidation: true,
      typePolicy: { ...defaultMySqlTypePolicy, json: "string" },
    });
    strict.strictEqual(text.columns[0]?.tsType, "string");
    strict.strictEqual(text.columns[0]?.json?.representation, "text");
    strict.strictEqual(jsonShapeType(checked.columns[0]!.json!.shape), "number");
  });
});
