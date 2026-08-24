import { describe, it, strict } from "poku";
import {
  createDatabase,
  defineConfig,
  DIALECT_CONTRACT_VERSION,
  renderQuery,
  rowTypeLiteral,
  sql,
  type DialectPlugin,
  type SchemaSnapshot,
  type SqlRenderer,
} from "../src/index.js";

const renderer: SqlRenderer = {
  placeholder: (index) => `$${index}`,
  quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
};

await describe("runtime SQL tag", async () => {
  await it("parameterizes ordinary values in order", async () => {
    const id = 42;
    const active = true;
    const query = sql`SELECT id FROM users WHERE id = ${id} AND active = ${active}`;
    strict.deepStrictEqual(renderQuery(query, renderer), {
      text: "SELECT id FROM users WHERE id = $1 AND active = $2",
      values: [42, true],
    });
  });

  await it("quotes explicit identifiers and preserves nested parameter ordering", async () => {
    const columns = sql.join([sql.ident("id"), sql.ident('display"name')]);
    const query = sql`SELECT ${columns} FROM users WHERE id = ${sql.value(7)}`;
    strict.deepStrictEqual(renderQuery(query, renderer), {
      text: 'SELECT "id", "display""name" FROM users WHERE id = $1',
      values: [7],
    });
  });

  await it("executes typed query values through an adapter", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const db = createDatabase({
      async execute(text, values): Promise<readonly unknown[]> {
        calls.push({ text, values });
        return [{ id: 1 }];
      },
    }, renderer);
    const rows = await db.execute(sql<{ id: number }>`SELECT id FROM users`);
    strict.deepStrictEqual(rows, [{ id: 1 }]);
    strict.strictEqual(calls[0]?.text, "SELECT id FROM users");
  });

  await it("keeps raw SQL explicit and validates identifier input", () => {
    strict.deepStrictEqual(renderQuery(sql.dynamic("SELECT 1"), renderer), { text: "SELECT 1", values: [] });
    strict.deepStrictEqual(renderQuery(sql`SELECT ${sql.raw("CURRENT_DATE")}`, renderer), {
      text: "SELECT CURRENT_DATE",
      values: [],
    });
    strict.throws(() => sql.ident(""), /non-empty/);
    strict.throws(() => sql.ident("bad\0name"), /NUL/);
  });

  await it("supports transaction executors and rejects missing transaction support", async () => {
    const executor = { async execute(): Promise<readonly unknown[]> { return [{ value: 2 }]; } };
    const db = createDatabase(executor, renderer, async (run) => run(executor));
    const value = await db.transaction(async (transaction) => (await transaction.execute(sql<{ value: number }>`SELECT 2 AS value`))[0]?.value);
    strict.strictEqual(value, 2);
    await strict.rejects(() => createDatabase(executor, renderer).transaction(async () => undefined), /does not support transactions/);
  });
});

await describe("core contracts", async () => {
  const schema = { dialect: "test", tables: {} } satisfies SchemaSnapshot;
  const dialect: DialectPlugin<SchemaSnapshot, Record<string, never>> = {
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "test",
    packageVersion: "1.0.0",
    defaultTypePolicy: {},
    placeholder: (index) => `?${index}`,
    analyze: () => ({ columns: [], diagnostics: [] }),
    validateSnapshot: () => schema,
  };

  await it("defines immutable typed configuration", () => {
    const config = defineConfig({ dialect, schema: { file: "schema.json" }, outDir: "generated" });
    strict.strictEqual(config.dialect, dialect);
    strict.ok(Object.isFrozen(config));
    strict.throws(() => defineConfig({
      dialect: { ...dialect, contractVersion: 2 as never },
      schema: { file: "schema.json" },
      outDir: "generated",
    }), /Unsupported typed-sql dialect contract/);
  });

  await it("renders deterministic TypeScript row literals", () => {
    strict.strictEqual(rowTypeLiteral([
      { name: "id", tsType: "bigint", nullable: false, range: { start: 0, end: 1, line: 1, column: 1 } },
      { name: "display name", tsType: "string", nullable: true, range: { start: 2, end: 3, line: 1, column: 3 } },
    ]), '{ "id": bigint; "display name": string | null; }');
  });
});
