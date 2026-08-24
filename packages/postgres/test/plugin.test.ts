import { describe, it, strict } from "poku";
import { postgres, type PostgresSchemaSnapshot } from "../src/index.js";

const schema = {
  dialect: "postgres",
  tables: {
    users: {
      name: "users",
      columns: { id: { name: "id", databaseType: "integer", tsType: "number", nullable: false } },
    },
  },
} as const satisfies PostgresSchemaSnapshot;

await describe("PostgreSQL dialect plugin", async () => {
  await it("validates snapshots and delegates analysis", () => {
    const dialect = postgres();
    strict.strictEqual(dialect.id, "postgres");
    strict.strictEqual(dialect.placeholder(2), "$2");
    strict.strictEqual(dialect.validateSnapshot(schema).dialect, "postgres");
    strict.strictEqual(dialect.analyze("SELECT id FROM users", schema).columns[0]?.tsType, "number");
    strict.strictEqual(dialect.analyze("SELECT", schema).diagnostics[0]?.code, "TSQ001");
    strict.throws(() => dialect.placeholder(0), /start at 1/);
    strict.throws(() => dialect.placeholder(1.5), /start at 1/);
    strict.throws(() => dialect.validateSnapshot({ dialect: "mysql", tables: {} }), /cannot use a mysql/);
  });

  await it("accepts an explicit default type policy", () => {
    const configured = postgres({
      typePolicy: { bigint: "string", numeric: "number", date: "string", json: "string", enums: "string", unknown: "never" },
    });
    strict.strictEqual(configured.defaultTypePolicy.bigint, "string");
  });
});
