import { describe, it, strict } from "poku";
import { rowTypeLiteral } from "../../core/src/index.js";
import type { SchemaSnapshot } from "../../schema/src/index.js";
import { parseSelect } from "../src/parser/index.js";
import { resolveSelect } from "../src/resolver.js";
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

  await it("does not infer closed objects from dynamic, duplicate, variadic or nonliteral keys", () => {
    for (const call of [
      "jsonb_build_object(name, id)",
      "json_build_object('id', id, 'id', name)",
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
      "ARRAY[1, 2]",
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
    strict.strictEqual(rowTypeLiteral(fallback.columns), '{ "document": { "id": number; } | readonly never[]; }');
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
    strict.strictEqual(objectAggregate.columns[0]?.tsType, "unknown");
  });

  await it("unions possible JSON results from GREATEST and LEAST rather than retaining the first shape", () => {
    for (const name of ["GREATEST", "LEAST"]) {
      const result = analyze(`SELECT ${name}(jsonb_build_object('a', 1), jsonb_build_object('b', 'x')) AS document`);
      strict.deepStrictEqual(result.diagnostics, []);
      strict.strictEqual(rowTypeLiteral(result.columns), '{ "document": { "a": number; } | { "b": string; }; }');
    }
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
