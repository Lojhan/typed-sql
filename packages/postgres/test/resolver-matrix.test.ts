import { describe, it, strict } from "poku";
import { parseSelect, parseStatement } from "../../ast/src/index.js";
import type { SchemaSnapshot } from "../../schema/src/index.js";
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
  });

  await it("covers INSERT sources, defaults, target validation, UPDATE joins, and DELETE USING", () => {
    const defaults = resolveStatement(parseStatement("INSERT INTO users DEFAULT VALUES"), schema);
    strict.strictEqual(defaults.resultKind, "command");
    const allColumns = resolveStatement(
      parseStatement("INSERT INTO users VALUES (1, 'Ada', NULL, true, '{}'::jsonb, ARRAY[1])"),
      schema,
    );
    strict.deepStrictEqual(allColumns.diagnostics, []);
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
    const nonLateral = resolveSelect(
      parseSelect("SELECT derived.id FROM users u CROSS JOIN (SELECT u.id) derived"),
      schema,
    );
    strict.ok(nonLateral.diagnostics.some((diagnostic) => diagnostic.code === "TSQ103"));
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
