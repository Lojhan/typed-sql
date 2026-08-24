import { performance } from "node:perf_hooks";
import { describe, it, strict } from "poku";
import type { DialectPlugin, SchemaSnapshot } from "../../core/src/index.js";
import { compileSource } from "../src/index.js";

const schema = { formatVersion: 1, dialect: "performance", tables: {} } as const satisfies SchemaSnapshot;
const dialect: DialectPlugin<typeof schema, Record<string, never>> = {
  contractVersion: 1,
  id: "performance",
  grammarVersion: "1.0.0",
  sqlModule: "@example/typed-sql-performance",
  defaultTypePolicy: {},
  placeholder: (index) => `$${index}`,
  validateSnapshot: () => schema,
  analyze: (_sql, _snapshot) => ({
    columns: [{
      name: "id",
      tsType: "number",
      nullable: false,
      databaseType: "integer",
      range: { start: 7, end: 9, line: 1, column: 8 },
    }],
    diagnostics: [],
    resultKind: "rows",
  }),
};

await describe("compiler performance budget", async () => {
  await it("transforms a one-thousand-query workspace file within the published budget", () => {
    const source = [
      'import { sql } from "@example/typed-sql-performance";',
      ...Array.from({ length: 1_000 }, (_, index) => `export const query${index} = sql\`SELECT id FROM table_${index} WHERE id = \${${index}}\`;`),
    ].join("\n");
    const budget = Number(process.env.TYPED_SQL_COMPILER_BUDGET_MS ?? "3000");
    const start = performance.now();
    const result = compileSource({ source, schema, dialect });
    const duration = performance.now() - start;
    strict.strictEqual(result.queries.length, 1_000);
    strict.ok(duration <= budget, `Compiler took ${duration.toFixed(1)}ms; budget is ${budget}ms`);
  });
});
