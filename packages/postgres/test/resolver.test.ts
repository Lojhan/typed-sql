import { describe, it, strict } from "poku";
import { parseSelect, parseStatement } from "../../ast/src/index.js";
import {
  resolveSelect,
  resolveStatement,
} from "../src/resolver.js";
import { rowTypeLiteral } from "../../core/src/index.js";
import type { SchemaSnapshot } from "../../schema/src/index.js";

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
    const result = resolveSelect(parseSelect("SELECT a.label FROM users u LEFT JOIN ages a ON u.id = a.user_id"), schema);
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
      typePolicy: { bigint: "string", numeric: "string", date: "Date", json: "unknown", enums: "string-union", unknown: "unknown" },
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

    const unnamed = resolveSelect(parseSelect("SELECT id + 1 FROM users"), schema);
    strict.strictEqual(unnamed.diagnostics[0]?.code, "TSQ104");
    const permissive = resolveSelect(parseSelect("SELECT id + 1 FROM users"), schema, { strictExpressions: false });
    strict.deepStrictEqual(permissive.diagnostics, []);
    strict.deepStrictEqual(permissive.columns, []);
  });

  await it("resolves literals, parameters, unary/binary expressions, and CASE nullability", async () => {
    const result = resolveSelect(parseSelect(`
      SELECT 'ok' AS text_value,
             NULL AS missing,
             $1 AS input,
             NOT (age IS NULL) AS has_age,
             -id AS negative_id,
             id + 1 AS next_id,
             id + 'x' AS mixed,
             CASE WHEN age IS NULL THEN 0 END AS maybe_age,
             CASE WHEN age IS NULL THEN 0 ELSE age END AS safe_age
      FROM users
    `), schema);
    strict.deepStrictEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["TSQ203"]);
    strict.deepStrictEqual(result.columns.map(({ name, tsType, nullable }) => ({ name, tsType, nullable })), [
      { name: "text_value", tsType: "string", nullable: false },
      { name: "missing", tsType: "unknown", nullable: true },
      { name: "input", tsType: "unknown", nullable: true },
      { name: "has_age", tsType: "boolean", nullable: false },
      { name: "negative_id", tsType: "number", nullable: false },
      { name: "next_id", tsType: "number", nullable: false },
      { name: "mixed", tsType: "unknown", nullable: true },
      { name: "maybe_age", tsType: "number", nullable: true },
      { name: "safe_age", tsType: "number", nullable: true },
    ]);
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
    const result = resolveSelect(parseSelect(`
      SELECT u.id, a.label,
             COUNT(*) AS total,
             COALESCE(a.label, 'none') AS label_or_default,
             MIN(u.age) AS minimum,
             MAX(u.age) AS maximum,
             SUM(u.age) AS sum_value,
             label_for(u.id) AS computed,
             mystery(u.id) AS unsupported
      FROM users u RIGHT JOIN ages a ON u.id = a.user_id
    `), functions);
    strict.strictEqual(result.columns.find((column) => column.name === "id")?.nullable, true);
    strict.strictEqual(result.columns.find((column) => column.name === "label")?.nullable, false);
    strict.strictEqual(result.columns.find((column) => column.name === "total")?.tsType, "bigint");
    strict.strictEqual(result.columns.find((column) => column.name === "computed")?.tsType, "string");
    strict.strictEqual(result.diagnostics.at(-1)?.code, "TSQ202");
    strict.strictEqual(result.diagnostics.at(-1)?.severity, "warning");

    const full = resolveSelect(parseSelect("SELECT u.id, a.label FROM users u FULL JOIN ages a ON u.id = a.user_id"), schema);
    strict.ok(full.columns.every((column) => column.nullable));
  });

  await it("reports dialect mismatch and renders nullable rows", async () => {
    const mismatch = resolveSelect(parseSelect("SELECT id FROM users"), { ...schema, dialect: "mysql" });
    strict.strictEqual(mismatch.diagnostics[0]?.code, "TSQ007");
    strict.strictEqual(rowTypeLiteral([{ name: "value", tsType: "string", nullable: true, range: { start: 0, end: 1, line: 1, column: 1 } }]), '{ "value": string | null; }');
  });

  await it("expands stars and models JOIN USING as one unambiguous property", () => {
    const result = resolveSelect(parseSelect(`
      SELECT *
      FROM users u
      LEFT JOIN ages a USING (id)
    `), {
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
    });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(result.columns.map(({ name, nullable }) => ({ name, nullable })), [
      { name: "id", nullable: false },
      { name: "name", nullable: false },
      { name: "age", nullable: true },
      { name: "label", nullable: true },
    ]);
  });

  await it("resolves CTEs, derived tables, correlated scalar subqueries, EXISTS, and IN", () => {
    const result = resolveStatement(parseStatement(`
      WITH named AS (
        SELECT u.id, u.name FROM users u WHERE EXISTS (SELECT 1 AS one FROM ages a WHERE a.user_id = u.id)
      )
      SELECT n.id,
             n.name,
             (SELECT a.label FROM ages a WHERE a.user_id = n.id LIMIT 1) AS label
      FROM (SELECT id, name FROM named) n
      WHERE n.id IN (SELECT user_id FROM ages)
    `), schema);
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(result.columns.map(({ name, tsType, nullable }) => ({ name, tsType, nullable })), [
      { name: "id", tsType: "number", nullable: false },
      { name: "name", tsType: "string", nullable: false },
      { name: "label", tsType: "string", nullable: true },
    ]);
  });

  await it("infers data-changing RETURNING rows and uses never for command-only statements", () => {
    const insert = resolveStatement(parseStatement("INSERT INTO users (name, age) VALUES ('Ada', 37) RETURNING id, name"), schema);
    strict.strictEqual(insert.resultKind, "rows");
    strict.deepStrictEqual(insert.columns.map(({ name, tsType }) => ({ name, tsType })), [
      { name: "id", tsType: "number" },
      { name: "name", tsType: "string" },
    ]);
    const update = resolveStatement(parseStatement("UPDATE users u SET age = age + 1 WHERE u.id = $1 RETURNING u.*"), schema);
    strict.strictEqual(update.resultKind, "rows");
    strict.strictEqual(update.columns.length, 3);
    const deletion = resolveStatement(parseStatement("DELETE FROM users WHERE id = $1"), schema);
    strict.strictEqual(deletion.resultKind, "command");
    strict.deepStrictEqual(deletion.columns, []);
    const mismatch = resolveStatement(parseStatement("INSERT INTO users (name) VALUES ('Ada', 'extra')"), schema);
    strict.ok(mismatch.diagnostics.some((diagnostic) => diagnostic.code === "TSQ214"));
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
            scores: { name: "scores", databaseType: "integer[]", tsType: "readonly (number)[]", nullable: false, array: true },
            active: { name: "active", databaseType: "boolean", tsType: "boolean", nullable: false },
            team_id: { name: "team_id", databaseType: "integer", tsType: "number", nullable: false },
          },
        },
      },
      functions: {
        "label_for(integer)": { name: "label_for", argumentTypes: ["integer"], databaseReturnType: "text", returnType: "string", nullable: false },
        "label_for(text)": { name: "label_for", argumentTypes: ["text"], databaseReturnType: "text", returnType: "string", nullable: true },
      },
    } as const satisfies SchemaSnapshot;
    const result = resolveSelect(parseSelect(`
      SELECT ARRAY[1, 2] AS ids,
             payload->>'name' AS name,
             scores || ARRAY[3] AS all_scores,
             COUNT(*) FILTER (WHERE active) OVER (PARTITION BY team_id) AS active_count,
             label_for(team_id) AS team_label
      FROM events
    `), richSchema);
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(result.columns.map(({ name, tsType }) => ({ name, tsType })), [
      { name: "ids", tsType: "readonly (number)[]" },
      { name: "name", tsType: "string" },
      { name: "all_scores", tsType: "readonly (number)[]" },
      { name: "active_count", tsType: "bigint" },
      { name: "team_label", tsType: "string" },
    ]);
  });

  await it("fails recursive CTEs and ambiguous overloads safely", () => {
    const recursive = resolveStatement(parseStatement("WITH RECURSIVE n(value) AS (SELECT 1 AS value) SELECT value FROM n"), schema);
    strict.strictEqual(recursive.diagnostics[0]?.code, "TSQ210");
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
