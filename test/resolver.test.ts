import { describe, it, strict } from "poku";
import { parseSelect } from "../packages/ast/src/index.js";
import {
  resolveSelect,
  rowTypeLiteral,
  type SchemaSnapshot,
} from "../packages/schema/src/index.js";

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
});
