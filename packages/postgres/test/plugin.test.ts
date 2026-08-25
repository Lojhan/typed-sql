import { describe, it, strict } from "poku";
import { defaultPostgresTypePolicy, type PostgresSchemaSnapshot, postgres, sql, typePolicy } from "../src/index.js";

const schema = {
  formatVersion: 1,
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
    strict.strictEqual(dialect.sqlModule, "@typed-sql/postgres");
    strict.strictEqual(dialect.capabilities.returning, true);
    strict.strictEqual(dialect.placeholder(2), "$2");
    strict.strictEqual(dialect.quoteIdentifier('account"status'), '"account""status"');
    strict.strictEqual(dialect.validateSnapshot(schema).dialect, "postgres");
    strict.strictEqual(dialect.analyze("SELECT id FROM users", schema).columns[0]?.tsType, "number");
    strict.strictEqual(dialect.analyze("SELECT", schema).diagnostics[0]?.code, "TSQ001");
    strict.throws(() => dialect.placeholder(0), /start at 1/);
    strict.throws(() => dialect.placeholder(1.5), /start at 1/);
    strict.throws(
      () => dialect.validateSnapshot({ formatVersion: 1, dialect: "mysql", tables: {} }),
      /cannot use a mysql/,
    );
    strict.throws(
      () => dialect.validateSnapshot({ ...schema, dialectVersion: "999" }),
      /cannot use snapshot dialectVersion 999/,
    );
  });

  await it("exposes one application API from the dialect package root", () => {
    strict.strictEqual(sql`SELECT 1`.segments[0]?.kind, "text");
    strict.strictEqual(typePolicy, defaultPostgresTypePolicy);
    strict.strictEqual(postgres({ typePolicy }).defaultTypePolicy, typePolicy);
  });

  await it("accepts an explicit default type policy", () => {
    const configured = postgres({
      typePolicy: {
        bigint: "string",
        numeric: "number",
        date: "string",
        json: "string",
        enums: "string",
        unknown: "never",
      },
    });
    strict.strictEqual(configured.defaultTypePolicy.bigint, "string");
  });
});
