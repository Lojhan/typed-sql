import { performance } from "node:perf_hooks";
import { describe, it, strict } from "poku";
import {
  DIALECT_CONTRACT_VERSION,
  type DialectPlugin,
  type SchemaSnapshot,
  unknownQuerySemantics,
} from "../../core/src/index.js";
import { compileSource, extractStaticQueries } from "../src/index.js";

const schema = { formatVersion: 1, dialect: "performance", tables: {} } as const satisfies SchemaSnapshot;
const dialect: DialectPlugin<typeof schema, Record<string, never>> = {
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: "performance",
  grammarVersion: "1.0.0",
  sqlModule: "@example/typed-sql-performance",
  capabilities: {},
  defaultTypePolicy: {},
  placeholder: (index) => `$${index}`,
  quoteIdentifier: (identifier) => `"${identifier}"`,
  validateSnapshot: () => schema,
  analyze: (sql, _snapshot) => ({
    columns: [
      {
        name: "id",
        tsType: "number",
        nullable: false,
        databaseType: "integer",
        range: { start: 7, end: 9, line: 1, column: 8 },
      },
    ],
    parameters: [],
    diagnostics: [],
    resultKind: "rows",
    semantics: unknownQuerySemantics({ start: 0, end: sql.length, line: 1, column: 1 }, "Performance grammar"),
  }),
};

function structuralSource(conditions: readonly string[]): string {
  return [
    'import { sql } from "@example/typed-sql-performance";',
    `interface Selection { ${[...new Set(conditions)].map((name) => `${name}: boolean`).join("; ")} }`,
    "function query<const Select extends Selection>(select: Select) {",
    "  return sql`SELECT 1 AS id",
    ...conditions.map(
      (name, index) => `    \${select.${name} ? sql.fragment\`, ${index + 2} AS value_${index}\` : sql.empty}`,
    ),
    "  `;",
    "}",
  ].join("\n");
}

await describe("compiler performance budget", async () => {
  await it("transforms a one-thousand-query workspace file within the published budget", () => {
    const source = [
      'import { sql } from "@example/typed-sql-performance";',
      ...Array.from(
        { length: 1_000 },
        (_, index) => `export const query${index} = sql\`SELECT id FROM table_${index} WHERE id = \${${index}}\`;`,
      ),
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

  await it("rejects exponential structural work before invoking a grammar", () => {
    let analyses = 0;
    const measured = {
      ...dialect,
      analyze: (...args: Parameters<typeof dialect.analyze>) => {
        analyses += 1;
        return dialect.analyze(...args);
      },
    };
    const start = performance.now();
    const result = compileSource({
      source: structuralSource(Array.from({ length: 20 }, (_, index) => `field_${index}`)),
      schema,
      dialect: measured,
      maxStructuralVariants: 64,
    });
    const duration = performance.now() - start;
    strict.strictEqual(result.diagnostics[0]?.code, "TSQ003");
    strict.strictEqual(analyses, 0);
    strict.ok(duration <= 250, `Structural limit took ${duration.toFixed(1)}ms`);
  });

  await it("correlates repeated conditions and stays within the structural budget", () => {
    let analyses = 0;
    const measured = {
      ...dialect,
      analyze: (...args: Parameters<typeof dialect.analyze>) => {
        analyses += 1;
        return dialect.analyze(...args);
      },
    };
    const start = performance.now();
    const result = compileSource({
      source: structuralSource(Array.from({ length: 20 }, () => "details")),
      schema,
      dialect: measured,
      maxStructuralVariants: 64,
    });
    const duration = performance.now() - start;
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(analyses, 2);
    strict.strictEqual(result.queries.length, 1);
    strict.ok(duration <= 250, `Correlated structural analysis took ${duration.toFixed(1)}ms`);
  });
});
