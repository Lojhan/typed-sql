import { describe, it, strict } from "poku";
import type { SchemaSnapshot } from "../../schema/src/index.js";
import { isKnownPostgresType, mapPostgresType, type PostgresTypePolicy } from "../src/type-policy.js";

const policy: PostgresTypePolicy = {
  bigint: "bigint",
  numeric: "string",
  date: "Date",
  json: "unknown",
  enums: "string-union",
  unknown: "never",
};
const schema = {
  dialect: "postgres",
  tables: {},
  enums: { mood: ["happy", "sad"], "app.state": ["on", "off"] },
  domains: {
    positive: { name: "positive", databaseType: "integer", tsType: "number", nullable: false },
  },
} as const satisfies SchemaSnapshot;

await describe("PostgreSQL type policy", async () => {
  await it("maps every supported scalar family and modifiers", () => {
    strict.strictEqual(mapPostgresType("smallint", policy), "number");
    strict.strictEqual(mapPostgresType("BIGINT", policy), "bigint");
    strict.strictEqual(mapPostgresType("numeric(10, 2)", policy), "string");
    strict.strictEqual(mapPostgresType("bool", policy), "boolean");
    strict.strictEqual(mapPostgresType("character varying(30)", policy), "string");
    strict.strictEqual(mapPostgresType("timestamp with time zone", policy), "Date");
    strict.strictEqual(mapPostgresType("jsonb", policy), "unknown");
    strict.strictEqual(mapPostgresType("bytea", policy), "Uint8Array");
    strict.strictEqual(mapPostgresType("made_up", policy), "never");
  });

  await it("maps arrays, domains, and both enum policies", () => {
    strict.strictEqual(mapPostgresType("positive", policy, schema), "number");
    strict.strictEqual(mapPostgresType("mood", policy, schema), '"happy" | "sad"');
    strict.strictEqual(mapPostgresType("app.state[]", policy, schema), 'readonly ("on" | "off")[]');
    strict.strictEqual(mapPostgresType("mood", { ...policy, enums: "string" }, schema), "string");
  });

  await it("recognizes built-ins and snapshot-defined types", () => {
    strict.strictEqual(isKnownPostgresType("numeric(10,2)[]"), true);
    strict.strictEqual(isKnownPostgresType("mood", schema), true);
    strict.strictEqual(isKnownPostgresType("positive", schema), true);
    strict.strictEqual(isKnownPostgresType("made_up", schema), false);
    strict.strictEqual(isKnownPostgresType("made_up"), false);
  });
});
