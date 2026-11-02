import { describe, it, strict } from "poku";
import { COMMERCE_FILES } from "../../website/.vitepress/theme/playground/commerce-example.js";
import { validWorkspaceFiles } from "../../website/.vitepress/theme/playground/workspace.js";
import { createTestWorkspace } from "../helpers/playground-workspace.js";

await describe("advanced commerce playground", async () => {
  const service = createTestWorkspace();
  try {
    const result = service.analyze("postgres", COMMERCE_FILES);
    await it("checks the complete schema, SQL imports, and workflow modules without diagnostics", () => {
      strict.ok(validWorkspaceFiles(COMMERCE_FILES));
      strict.deepStrictEqual(result.problems, []);
      strict.strictEqual(result.queries.length, 8);
      const joined = result.queries.find(({ binding }) => binding === "accountById")!;
      strict.match(joined.rowType, /"team_name": string \| null/u);
      strict.match(joined.rowType, /"owner" \| "admin" \| "member" \| null/u);
      strict.strictEqual(joined.parameterType, "readonly [bigint]");
      const revenue = result.queries.find(({ binding }) => binding === "revenueByCustomer")!;
      strict.strictEqual(revenue.file, "queries/revenue.sql");
      strict.match(revenue.rowType, /"order_count": bigint/u);
    });
    await it("preserves inferred fragment-list arrays and exact literal parameter tuples", () => {
      const mapped = result.queries.find(({ binding }) => binding === "insertProducts")!;
      strict.match(mapped.parameterType, /^readonly \(.+\)\[\]$/u);
      for (const member of ["bigint", "string", "number", "boolean"]) strict.ok(mapped.parameterType.includes(member));
      strict.ok(!mapped.parameterType.includes("unknown"));
      const wrong = {
        ...COMMERCE_FILES,
        "queries/insert-products.ts": COMMERCE_FILES["queries/insert-products.ts"].replace(
          "readonly priceCents: number",
          "readonly priceCents: string",
        ),
      };
      strict.ok(
        service
          .analyze("postgres", wrong)
          .problems.some(
            ({ file, message }) => file === "queries/insert-products.ts" && /string.*number/u.test(message),
          ),
      );
      service.analyze("postgres", COMMERCE_FILES);
      strict.strictEqual(
        result.queries.find(({ binding }) => binding === "insertPair")!.parameterType,
        "readonly [bigint, string, string, number, boolean, bigint, string, string, number, boolean]",
      );
    });
    await it("infers nested JSON fields and keeps each batch result distinct without any", () => {
      const json = result.queries.find(({ binding }) => binding === "orderDocument")!;
      strict.match(json.rowType, /"customer": \{ "email": string;/u);
      strict.match(json.rowType, /"items": readonly/u);
      strict.match(json.rowType, /"quantity": number/u);
      const batch = result.hovers["workflows/batch.ts"]!;
      for (const name of ["accounts", "products", "orders"]) {
        const hover = batch.find(({ from }) => from === COMMERCE_FILES["workflows/batch.ts"].indexOf(name))!;
        strict.ok(hover.content.includes("readonly"));
        strict.ok(!/\bany\b/u.test(hover.content));
      }
      const bad = {
        ...COMMERCE_FILES,
        "app.ts": COMMERCE_FILES["app.ts"].replace("accountById(42n)", 'accountById("42")'),
      };
      strict.ok(
        service.analyze("postgres", bad).problems.some(({ file, code }) => file === "app.ts" && code === "TS2345"),
      );
    });
  } finally {
    service.dispose();
  }
});
