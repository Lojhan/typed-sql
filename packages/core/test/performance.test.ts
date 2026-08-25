import { performance } from "node:perf_hooks";
import { describe, it, strict } from "poku";
import { ResolverSchemaIndex, renderQuery, type SchemaSnapshot, sql } from "../src/index.js";

const budget = (name: string, fallback: number): number => Number(process.env[name] ?? fallback);

await describe("core performance budgets", async () => {
  await it("indexes and repeatedly resolves a large grammar-neutral schema", () => {
    const tables = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [
        `schema_${index % 10}.table_${index}`,
        {
          schema: `schema_${index % 10}`,
          name: `table_${index}`,
          columns: {
            id: { name: "id", databaseType: "integer", tsType: "number", nullable: false },
            label: { name: "label", databaseType: "text", tsType: "string", nullable: true },
          },
        },
      ]),
    );
    const snapshot: SchemaSnapshot = { formatVersion: 1, dialect: "performance", tables };
    const start = performance.now();
    const index = new ResolverSchemaIndex(snapshot);
    for (let iteration = 0; iteration < 100_000; iteration += 1) {
      const tableIndex = iteration % 5_000;
      const table = index.tables(`table_${tableIndex}`, `schema_${tableIndex % 10}`)[0]?.table;
      if (table === undefined || index.column(table, "LABEL")?.tsType !== "string") {
        throw new Error(`Resolver index missed table_${tableIndex}`);
      }
    }
    const duration = performance.now() - start;
    const maximum = budget("TYPED_SQL_CORE_INDEX_BUDGET_MS", 1_500);
    strict.ok(duration <= maximum, `Schema indexing and lookups took ${duration.toFixed(1)}ms; budget is ${maximum}ms`);
  });

  await it("constructs and renders composed parameterized queries without quadratic string work", () => {
    const renderer = {
      placeholder: (index: number) => `$${index}`,
      quoteIdentifier: (name: string) => `"${name}"`,
    };
    const start = performance.now();
    for (let iteration = 0; iteration < 25_000; iteration += 1) {
      const predicate = sql.and([
        sql.fragment`account.id >= ${iteration}`,
        iteration % 2 === 0 ? sql.fragment`account.active = ${true}` : undefined,
      ]);
      const query = sql`SELECT ${sql.ident("id")} FROM accounts WHERE ${predicate}`;
      const rendered = renderQuery(query, renderer);
      if (rendered.values[0] !== iteration) throw new Error(`Runtime parameter order changed at ${iteration}`);
    }
    const duration = performance.now() - start;
    const maximum = budget("TYPED_SQL_CORE_RUNTIME_BUDGET_MS", 1_500);
    strict.ok(
      duration <= maximum,
      `Query construction and rendering took ${duration.toFixed(1)}ms; budget is ${maximum}ms`,
    );
  });
});
