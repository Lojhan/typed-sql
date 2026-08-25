import { performance } from "node:perf_hooks";
import { describe, it, strict } from "poku";
import { DIALECT_CONTRACT_VERSION, type DialectPlugin, type SchemaSnapshot } from "../../core/src/index.js";
import { compileSource, extractStaticQueries } from "../src/index.js";

const schema = { formatVersion: 1, dialect: "performance", tables: {} } as const satisfies SchemaSnapshot;
const dialect: DialectPlugin<typeof schema, Record<string, never>> = {
  contractVersion: DIALECT_CONTRACT_VERSION,
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
    parameters: [],
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

  await it("rejects a large malformed import in linear time", () => {
    const source = "import{{".repeat(100_000);
    const budget = Number(process.env.TYPED_SQL_SCANNER_SECURITY_BUDGET_MS ?? "1000");
    const start = performance.now();
    const result = extractStaticQueries(source, (index) => `$${index}`);
    const duration = performance.now() - start;
    strict.deepStrictEqual(result, []);
    strict.ok(duration <= budget, `Scanner took ${duration.toFixed(1)}ms; budget is ${budget}ms`);
  });
});
