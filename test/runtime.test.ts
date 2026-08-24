import { describe, it, strict } from "poku";
import { createDatabase, sql } from "../packages/runtime/src/index.js";

await describe("runtime SQL tag", async () => {
  await it("parameterizes ordinary values in order", async () => {
    const id = 42;
    const active = true;
    const query = sql`SELECT id FROM users WHERE id = ${id} AND active = ${active}`;
    strict.strictEqual(query.text, "SELECT id FROM users WHERE id = $1 AND active = $2");
    strict.deepStrictEqual(query.values, [42, true]);
    strict.strictEqual(query.ast.kind, "select");
  });

  await it("quotes explicit identifiers and preserves nested parameter ordering", async () => {
    const columns = sql.join([sql.ident("id"), sql.ident('display"name')]);
    const query = sql`SELECT ${columns} FROM users WHERE id = ${sql.value(7)}`;
    strict.strictEqual(query.text, 'SELECT "id", "display""name" FROM users WHERE id = $1');
    strict.deepStrictEqual(query.values, [7]);
  });

  await it("executes typed query values through an adapter", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const db = createDatabase({
      async execute(text, values): Promise<readonly unknown[]> {
        calls.push({ text, values });
        return [{ id: 1 }];
      },
    });
    const rows = await db.execute(sql<{ id: number }>`SELECT id FROM users`);
    strict.deepStrictEqual(rows, [{ id: 1 }]);
    strict.strictEqual(calls[0]?.text, "SELECT id FROM users");
  });
});
