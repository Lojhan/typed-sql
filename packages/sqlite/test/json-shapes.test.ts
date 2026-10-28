import { DatabaseSync } from "node:sqlite";
import {
  decodeQueryResultRows,
  encodeQueryValues,
  rowTypeLiteral as formatRowType,
  jsonShapeType,
  renderQuery,
  sql,
  validateJsonValue,
  withQueryValuePlan,
} from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { defaultSqliteTypePolicy, parseSqliteSchemaSnapshot, type SqliteTypePolicy, sqlite } from "../src/index.js";
import { readNodeSqliteServerEvidence } from "../src/node-sqlite.js";
import { sqliteRenderer, sqliteRuntimeValueType } from "../src/query.js";

const database = new DatabaseSync(":memory:");
database.exec(
  "CREATE TABLE item(id INTEGER PRIMARY KEY, value TEXT) STRICT; INSERT INTO item VALUES (1, 'one'), (2, NULL)",
);
const snapshot = parseSqliteSchemaSnapshot({
  formatVersion: 1,
  dialect: "sqlite",
  server: readNodeSqliteServerEvidence(database),
  tables: {
    item: {
      name: "item",
      kind: "table",
      strict: true,
      columns: {
        id: { name: "id", databaseType: "INTEGER", tsType: "bigint", nullable: false },
        value: { name: "value", databaseType: "TEXT", tsType: "string", nullable: true },
      },
    },
  },
});

function analyze(text: string, policy: SqliteTypePolicy = defaultSqliteTypePolicy, runtimeValidation = false) {
  const result = sqlite().analyze(text, snapshot, policy, { runtimeValidation });
  strict.deepEqual(result.diagnostics, [], text);
  return result;
}

const rowTypeLiteral = (analysis: ReturnType<typeof analyze>) => formatRowType(analysis.columns);

function execute(text: string, policy: SqliteTypePolicy = defaultSqliteTypePolicy, runtimeValidation = false) {
  const analysis = analyze(text, policy, runtimeValidation);
  const statement = database.prepare(text);
  statement.setReadBigInts(policy.integer === "bigint");
  const native = statement.all();
  const query = withQueryValuePlan(sql`${sql.raw(text)}`, {
    dialect: "sqlite",
    typePolicyHash: "fixture",
    parameters: [],
    columns: analysis.columns.map((column) => ({
      ...column,
      type: column.runtimeType ?? sqliteRuntimeValueType(column, policy),
    })),
  });
  const rows = decodeQueryResultRows(query, native, {
    id: "native-sqlite",
    dialect: "sqlite",
    typePolicyHash: "fixture",
    integer: "lossless",
    jsonWire: "text",
  });
  return { analysis, rows, native };
}

try {
  await describe("SQLite JSON inference agrees with native storage and transient subtypes", async () => {
    await it("keeps default JSON text and binary JSONB, parsing only with validated opt-in", () => {
      const text = "SELECT json_object('id', id, 'value', value) AS result FROM item ORDER BY id";
      const plain = execute(text);
      strict.equal(rowTypeLiteral(plain.analysis), '{ "result": string; }');
      strict.deepEqual(
        plain.rows,
        plain.native.map((row) => ({ ...row })),
      );
      strict.equal(jsonShapeType(plain.analysis.columns[0]!.json!.shape), '{ "id": number; "value": string | null; }');
      const parsedPolicy = { ...defaultSqliteTypePolicy, json: "parsed" as const };
      strict.equal(rowTypeLiteral(analyze(text, parsedPolicy)), '{ "result": string; }');
      const parsed = execute(text, parsedPolicy, true);
      strict.deepEqual(parsed.rows, [{ result: { id: 1, value: "one" } }, { result: { id: 2, value: null } }]);
      strict.equal(parsed.analysis.columns[0]!.json!.requiresRuntimeValidation, true);
      const binary = execute("SELECT jsonb_object('id', 1) AS result", parsedPolicy, true);
      strict.equal(rowTypeLiteral(binary.analysis), '{ "result": Uint8Array; }');
      strict.ok((binary.rows[0] as { result: unknown }).result instanceof Uint8Array);
    });

    await it("observes TEXT subtype loss across CTEs/derived tables and persistence of JSONB", () => {
      const cases: readonly [string, string][] = [
        ["SELECT json_array(first_value(json_object('x', 1)) OVER ()) AS result", "readonly [string | null]"],
        ["SELECT json_array(lag(json_object('x', 1), 0) OVER ()) AS result", "readonly [string | null]"],
        [
          "SELECT json_array(CAST(json_extract(CASE WHEN id = 1 THEN json_object('a', json_object('x', 1)) ELSE json_object('a', 2) END, '$.a') AS TEXT)) AS result FROM item",
          'readonly [{ "x": number; } | string]',
        ],
        [
          "SELECT json_array(json_extract(CASE WHEN id = 1 THEN json_object('a', json_object('x', 1)) ELSE json_object('a', 'text') END, '$.a')) AS result FROM item",
          'readonly [{ "x": number; } | string]',
        ],
        ["SELECT json_array(json_object('id', 1)) AS result", 'readonly [{ "id": number; }]'],
        ["SELECT json_array(j) AS result FROM (SELECT json_object('id', 1) AS j) AS data", "readonly [string]"],
        [
          "WITH data AS (SELECT json_object('id', 1) AS j) SELECT json_array(j) AS result FROM data",
          "readonly [string]",
        ],
        [
          "SELECT json_array(j) AS result FROM (SELECT jsonb_object('id', 1) AS j) AS data",
          'readonly [{ "id": number; }]',
        ],
        ["SELECT json_array(CAST(json_object('id', 1) AS TEXT)) AS result", 'readonly [{ "id": number; }]'],
        ["SELECT json_array((SELECT json_object('id', 1))) AS result", 'readonly [{ "id": number; } | null]'],
        [
          "SELECT json_array(CASE WHEN id = 1 THEN json_object('id', id) ELSE 'plain' END) AS result FROM item",
          'readonly [{ "id": number; } | string]',
        ],
      ];
      for (const [text, expected] of cases) {
        const { analysis, native } = execute(text);
        const shape = analysis.columns[0]!.json!.shape;
        strict.equal(jsonShapeType(shape), expected, text);
        for (const row of native) strict.equal(validateJsonValue(JSON.parse(row.result as string), shape), true, text);
      }
    });

    await it("distinguishes native scalar extraction from serialized and multi-path JSON", () => {
      for (const policy of [defaultSqliteTypePolicy, { ...defaultSqliteTypePolicy, integer: "number" as const }]) {
        const booleans = execute(
          "SELECT json_extract('true', '$') AS truthy, json_extract('false', '$') AS falsy",
          policy,
        );
        strict.equal(
          rowTypeLiteral(booleans.analysis),
          policy.integer === "bigint"
            ? '{ "truthy": 0n | 1n; "falsy": 0n | 1n; }'
            : '{ "truthy": 0 | 1; "falsy": 0 | 1; }',
        );
        strict.deepEqual(booleans.rows, [
          { truthy: policy.integer === "bigint" ? 1n : 1, falsy: policy.integer === "bigint" ? 0n : 0 },
        ]);
      }
      const negated = execute("SELECT -json_extract('1', '$') AS value");
      strict.deepEqual(negated.rows, [{ value: -1n }]);
      strict.equal(negated.analysis.columns[0]!.scalarJsonShape, undefined);
      const numbers = execute(
        "SELECT json_extract('1', '$') AS int, json_extract('1.0', '$') AS real, json_extract('9223372036854775807', '$') AS large",
      );
      strict.deepEqual(numbers.rows, [{ int: 1n, real: 1, large: 9223372036854775807n }]);
      strict.equal(
        rowTypeLiteral(numbers.analysis),
        '{ "int": bigint | number; "real": bigint | number; "large": bigint | number; }',
      );
      const multi = execute("SELECT json_extract('{\"a\":1}', '$.missing', '$.a') AS result");
      strict.equal(jsonShapeType(multi.analysis.columns[0]!.json!.shape), "readonly [null, 1]");
      strict.equal((multi.rows[0] as { result: string }).result, "[null,1]");
      strict.equal(
        rowTypeLiteral(execute("SELECT json('{\"a\":null}') ->> 'a' AS result").analysis),
        '{ "result": never | null; }',
      );
      strict.equal(
        (execute("SELECT json('{\"a\":null}') -> 'a' AS result").rows[0] as { result: string }).result,
        "null",
      );
      const duplicate = execute("SELECT json_object('x', 1, 'x', 'string') ->> 'x' AS result");
      strict.deepEqual(duplicate.rows, [{ result: 1n }]);
    });

    await it("keeps dynamic JSON paths and ambiguous literal documents conservative", () => {
      const dynamic = analyze("SELECT json_extract(json_object('a', 1), ?) AS result");
      strict.equal(dynamic.parameters[0]!.tsType, "string");
      strict.equal(dynamic.columns[0]!.json, undefined);
      strict.equal(dynamic.columns[0]!.nullable, true);
      const duplicate = execute('SELECT json_extract(\'{"x":1,"x":"second"}\', \'$.x\') AS result');
      strict.deepEqual(duplicate.rows, [{ result: 1n }]);
      strict.equal(duplicate.analysis.columns[0]!.scalarJsonShape, undefined);
      const negativeZero = execute("SELECT json_set('[1,2]', '$[#-0]', 3) AS result");
      strict.equal((negativeZero.rows[0] as { result: string }).result, "[1,2,3]");
      strict.equal(jsonShapeType(negativeZero.analysis.columns[0]!.json!.shape), "readonly [1, 2, number]");
      const valueArgument = analyze("SELECT json_array(?) AS result");
      strict.equal("acceptsJsonInput" in valueArgument.parameters[0]!, false);
      const documentArgument = analyze("SELECT json(?) AS result");
      strict.equal(documentArgument.parameters[0]!.tsType, "bigint | number | string | Uint8Array");
      strict.equal((documentArgument.parameters[0] as unknown as { acceptsJsonInput?: true }).acceptsJsonInput, true);
      strict.equal(documentArgument.columns[0]!.json!.shape.kind, "unknown");
    });

    await it("accepts explicit JSON documents without excluding native numeric or JSONB inputs", () => {
      const blob = database.prepare("SELECT jsonb('{\"id\":7}') AS value").get()!.value as Uint8Array;
      const profile = {
        id: "native",
        dialect: "sqlite",
        typePolicyHash: "fixture",
        integer: "lossless" as const,
        jsonWire: "text" as const,
      };
      for (const value of [sql.json({ id: 7 }), 1n, blob]) {
        const query = sql`SELECT json(${value}) AS result`;
        const rendered = renderQuery(query, sqliteRenderer);
        const analysis = analyze(rendered.text);
        const planned = withQueryValuePlan(query, {
          dialect: "sqlite",
          typePolicyHash: "fixture",
          columns: analysis.columns.map((column) => ({
            ...column,
            type: column.runtimeType ?? sqliteRuntimeValueType(column),
          })),
          parameters: analysis.parameters.map((parameter) => ({
            ...parameter,
            type: sqliteRuntimeValueType(parameter),
          })),
        });
        strict.equal(analysis.parameters[0]!.acceptsJsonInput, true);
        const encoded = encodeQueryValues(planned, rendered.values, profile);
        const native = database
          .prepare(rendered.text)
          .all(...(encoded as (string | number | bigint | Uint8Array | null)[]));
        strict.deepEqual(
          decodeQueryResultRows(planned, native, profile),
          native.map((row) => ({ ...row })),
        );
      }
      const ordinary = sql`SELECT json_array(${sql.json({ id: 7 })}) AS result`;
      const rendered = renderQuery(ordinary, sqliteRenderer);
      const analysis = analyze(rendered.text);
      const planned = withQueryValuePlan(ordinary, {
        dialect: "sqlite",
        typePolicyHash: "fixture",
        columns: [],
        parameters: analysis.parameters.map((parameter) => ({ ...parameter, type: sqliteRuntimeValueType(parameter) })),
      });
      strict.throws(() => encodeQueryValues(planned, rendered.values, profile), /JSON parameter contract/u);
    });

    await it("uses declared shapes only with their actual trust boundary", () => {
      const declared = parseSqliteSchemaSnapshot({
        ...snapshot,
        tables: {
          ...snapshot.tables,
          docs: {
            name: "docs",
            kind: "table",
            strict: true,
            columns: {
              value: {
                name: "value",
                databaseType: "TEXT",
                tsType: "string",
                nullable: false,
                jsonDeclaration: {
                  source: "application",
                  shape: { kind: "object", properties: { enabled: { shape: { kind: "boolean" } } } },
                },
              },
            },
          },
        },
      });
      const query = "SELECT json_extract(value, '$.enabled') AS enabled FROM docs";
      const unvalidated = sqlite().analyze(query, declared);
      strict.equal(unvalidated.columns[0]!.scalarJsonShape, undefined);
      const validated = sqlite().analyze(query, declared, defaultSqliteTypePolicy, { runtimeValidation: true });
      strict.deepEqual(validated.diagnostics, []);
      strict.equal(rowTypeLiteral(validated), '{ "enabled": 0n | 1n; }');
      const result = validated.columns[0]!;
      const compiled = withQueryValuePlan(sql`SELECT 1 AS enabled`, {
        dialect: "sqlite",
        typePolicyHash: "fixture",
        columns: [{ ...result, type: result.runtimeType! }],
        parameters: [],
      });
      const profile = {
        id: "native",
        dialect: "sqlite",
        typePolicyHash: "fixture",
        integer: "lossless" as const,
        jsonWire: "text" as const,
      };
      strict.deepEqual(decodeQueryResultRows(compiled, [{ enabled: 1n }], profile), [{ enabled: 1n }]);
      strict.throws(() => decodeQueryResultRows(compiled, [{ enabled: 2n }], profile), /native JSON scalar/u);
      strict.throws(() => decodeQueryResultRows(compiled, [{ enabled: "bad" }], profile));
      for (const expression of [
        "CASE WHEN 1 THEN json_extract(value, '$.enabled') ELSE 'fallback' END",
        "coalesce(json_extract(value, '$.enabled'), 'fallback')",
      ]) {
        const output = sqlite().analyze(
          `SELECT ${expression} AS enabled FROM docs`,
          declared,
          defaultSqliteTypePolicy,
          { runtimeValidation: true },
        ).columns[0]!;
        const composed = withQueryValuePlan(sql`SELECT 1 AS enabled`, {
          dialect: "sqlite",
          typePolicyHash: "fixture",
          columns: [{ ...output, type: output.runtimeType! }],
          parameters: [],
        });
        strict.deepEqual(decodeQueryResultRows(composed, [{ enabled: "fallback" }], profile), [
          { enabled: "fallback" },
        ]);
        strict.throws(() => decodeQueryResultRows(composed, [{ enabled: 2n }], profile), /native JSON scalar/u);
      }
    });

    await it("creates missing optional parents without promising their previous fields", () => {
      database.exec("CREATE TABLE docproof(value TEXT NOT NULL) STRICT");
      const cases = [
        {
          shape: {
            kind: "object",
            properties: {
              a: { optional: true, shape: { kind: "object", properties: { keep: { shape: { kind: "number" } } } } },
            },
          },
          input: {},
          path: "$.a.x",
        },
        {
          shape: { kind: "array", element: { kind: "object", properties: { keep: { shape: { kind: "number" } } } } },
          input: [],
          path: "$[0].x",
        },
      ] as const;
      for (const test of cases) {
        database.prepare("DELETE FROM docproof").run();
        database.prepare("INSERT INTO docproof VALUES (?)").run(JSON.stringify(test.input));
        const declared = parseSqliteSchemaSnapshot({
          ...snapshot,
          tables: {
            ...snapshot.tables,
            docproof: {
              name: "docproof",
              kind: "table",
              strict: true,
              columns: {
                value: {
                  name: "value",
                  databaseType: "TEXT",
                  tsType: "string",
                  nullable: false,
                  jsonDeclaration: { source: "application", shape: test.shape },
                },
              },
            },
          },
        });
        const query = `SELECT json_set(value, '${test.path}', 'v') AS result FROM docproof`;
        const analysis = sqlite().analyze(query, declared, defaultSqliteTypePolicy, { runtimeValidation: true });
        strict.deepEqual(analysis.diagnostics, []);
        const actual = database.prepare(query).get()!.result as string;
        strict.equal(validateJsonValue(JSON.parse(actual), analysis.columns[0]!.json!.shape), true);
      }
      const parsed = execute(
        "WITH RECURSIVE data(j, n) AS (SELECT json('[]'), 0 UNION ALL SELECT json_array(j), n + 1 FROM data WHERE n < 2) SELECT j AS result FROM data",
        { ...defaultSqliteTypePolicy, json: "parsed" },
        true,
      );
      strict.equal(parsed.rows.length, 3);
      strict.deepEqual(parsed.rows[0], { result: [] });
      strict.deepEqual(parsed.rows[1], { result: ["[]"] });
      const missing = analyze("SELECT json_extract('{}', '$.a') AS result").columns[0]!;
      strict.deepEqual(missing.scalarJsonShape, { kind: "null" });
    });

    await it("models empty aggregates, SQL NULL members, updates, removal and merge patches", () => {
      const cases = [
        "SELECT json_group_array(value) AS result FROM item WHERE 0",
        "SELECT json_group_object(id, value) AS result FROM item WHERE 0",
        "SELECT json_group_array(value) FILTER (WHERE id > 0) OVER () AS result FROM item",
        "SELECT json_set('{}', '$.a.b', 1) AS result",
        "SELECT json_set('{}', '$.a[2]', 1) AS result",
        "SELECT json_set('[]', '$[#]', json_object('x', 1)) AS result",
        "SELECT json_insert('{\"a\":1}', '$.a', 'unchanged') AS result",
        "SELECT json_replace('{\"a\":1}', '$.a', 'changed') AS result",
        "SELECT json_remove('{\"a\":1,\"b\":2}', '$.a') AS result",
        'SELECT json_patch(\'{"a":1,"b":{"x":2}}\', \'{"a":null,"b":{"y":3}}\') AS result',
      ];
      for (const text of cases) {
        const { analysis, native } = execute(text);
        const column = analysis.columns[0]!;
        strict.equal(column.nullable, false, text);
        for (const row of native)
          strict.equal(validateJsonValue(JSON.parse(row.result as string), column.json!.shape), true, text);
      }
      strict.equal(
        rowTypeLiteral(execute("SELECT json_remove('{}', '$') AS result").analysis),
        '{ "result": never | null; }',
      );
    });
  });
} finally {
  database.close();
}
