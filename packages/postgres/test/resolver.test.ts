import { describe, it, strict } from "poku";
import { parseSelect } from "../../ast/src/index.js";
import {
  resolveSelect,
} from "../src/resolver.js";
import { rowTypeLiteral } from "../../core/src/index.js";
import type { SchemaSnapshot } from "../../schema/src/index.js";

const schema = {
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
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(result.columns.map(({ name, tsType, nullable }) => ({ name, tsType, nullable })), [
      { name: "text_value", tsType: "string", nullable: false },
      { name: "missing", tsType: "unknown", nullable: true },
      { name: "input", tsType: "unknown", nullable: true },
      { name: "has_age", tsType: "boolean", nullable: false },
      { name: "negative_id", tsType: "number", nullable: false },
      { name: "next_id", tsType: "number", nullable: false },
      { name: "mixed", tsType: "number", nullable: false },
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
});
