import { type QueryValuePlan, sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { createNodeSqliteDatabase } from "../src/node-sqlite.js";
import { defaultSqliteTypePolicy } from "../src/type-policy.js";

const identity = { dialect: "sqlite", typePolicyHash: calculateTypePolicyHash(defaultSqliteTypePolicy) };
const docColumn: QueryValuePlan["columns"][number] = {
  name: "doc",
  type: "string",
  nullable: false,
  json: { representation: "text", shape: { kind: "object", properties: { id: { shape: { kind: "number" } } } } },
};
const document = (text: string) =>
  withQueryValuePlan(sql`${sql.raw(text)}`, { ...identity, columns: [docColumn], parameters: [] });

await describe("native SQLite planned execution", async () => {
  await it("validates buffered, batched and streamed JSON and releases a failed cursor", async () => {
    const database = await createNodeSqliteDatabase({ path: ":memory:" });
    const valid = document("SELECT json_object('id', 1) AS doc");
    const invalid = document("SELECT 'not JSON' AS doc");
    try {
      strict.deepEqual(await database.one(valid), { doc: '{"id":1}' });
      strict.deepEqual(await database.batch([valid, valid]), [[{ doc: '{"id":1}' }], [{ doc: '{"id":1}' }]]);
      await strict.rejects(database.all(invalid), /invalid JSON/);
      await strict.rejects(database.batch([valid, invalid]), /invalid JSON/);
      const stream = database.stream(invalid);
      await strict.rejects(stream.next(), /invalid JSON/);
      strict.deepEqual(await database.one(valid), { doc: '{"id":1}' });
      await database.all(sql`CREATE TABLE events (payload TEXT)`);
      await strict.rejects(
        database.transaction(async (transaction) => {
          await transaction.all(sql`INSERT INTO events VALUES ('temporary')`);
          await transaction.all(invalid);
        }),
        /invalid JSON/,
      );
      strict.deepEqual(await database.all(sql`SELECT payload FROM events`), []);
    } finally {
      await database.close();
    }
  });
  await it("preserves JSON null and SQL NULL and rejects policy mismatch before dispatch", async () => {
    const database = await createNodeSqliteDatabase({ path: ":memory:" });
    const bind = (input: unknown) =>
      withQueryValuePlan(sql`SELECT json_type(${input}) AS kind`, {
        ...identity,
        columns: [{ name: "kind", type: "string", nullable: true }],
        parameters: [
          { index: 1, type: "unknown", nullable: true, json: { representation: "parsed", shape: { kind: "unknown" } } },
        ],
      });
    try {
      strict.deepEqual(await database.one(bind(sql.json(null))), { kind: "null" });
      strict.deepEqual(await database.one(bind(null)), { kind: null });
      await database.all(sql`CREATE TABLE items (id INTEGER)`);
      const mismatch = withQueryValuePlan(sql`INSERT INTO items VALUES (1)`, {
        ...identity,
        typePolicyHash: "other",
        columns: [],
        parameters: [],
      });
      await strict.rejects(database.all(mismatch), /policies/);
      strict.deepEqual(await database.all(sql`SELECT id FROM items`), []);
    } finally {
      await database.close();
    }
  });
});
