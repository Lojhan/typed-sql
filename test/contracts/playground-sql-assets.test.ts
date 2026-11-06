import { describe, it, strict } from "poku";
import { DEFAULT_SCHEMAS, PLAYGROUND_DIALECTS } from "../../website/.vitepress/theme/playground/playground.js";
import { lessonFiles } from "../../website/.vitepress/theme/playground/workspace.js";
import { createTestWorkspace } from "../helpers/playground-workspace.js";

await describe("SQL-file bindings and application identities in the playground", async () => {
  const workspace = createTestWorkspace();
  try {
    for (const dialect of PLAYGROUND_DIALECTS) {
      await it(`checks ${dialect} named bindings and rejects wrong arguments at the consumer`, () => {
        const files = lessonFiles(dialect, "bindings", DEFAULT_SCHEMAS[dialect]);
        const result = workspace.analyze(dialect, files);
        strict.deepStrictEqual(result.problems, []);
        strict.strictEqual(
          result.queries.find(({ binding }) => binding === "ordersByCustomer")!.parameterType,
          "readonly [bigint, bigint]",
        );
        const wrong = {
          ...files,
          "app.ts": files["app.ts"].replace("ordersByCustomer({ userId })", 'ordersByCustomer({ userId: "42" })'),
        };
        strict.ok(
          workspace.analyze(dialect, wrong).problems.some(({ file, code }) => file === "app.ts" && code === "TS2322"),
        );
        const positional = result.queries.find(({ binding }) => binding === "accountByPosition")!;
        strict.strictEqual(
          positional.parameterType,
          dialect === "postgres" || dialect === "duckdb"
            ? "readonly [string, bigint, bigint]"
            : "readonly [string, bigint]",
        );
        const mixed = {
          ...files,
          "queries/orders.sql": files["queries/orders.sql"]!.replace(
            `OR user_id = ${dialect === "duckdb" ? "$" : dialect === "sqlserver" ? "@" : ":"}userId`,
            `OR user_id = ${dialect === "postgres" || dialect === "duckdb" ? "$1" : "?"}`,
          ),
        };
        strict.ok(
          workspace
            .analyze(dialect, mixed)
            .problems.some(
              ({ file, code, message }) =>
                file === "queries/orders.sql" && code === "TSQ901" && message.includes("cannot mix"),
            ),
        );
      });
      await it(`carries ${dialect} brands through SQL imports, inline templates and adapter results`, () => {
        const files = lessonFiles(dialect, "brands", DEFAULT_SCHEMAS[dialect]);
        const result = workspace.analyze(dialect, files);
        strict.deepStrictEqual(result.problems, []);
        const orders = result.queries.find(({ binding }) => binding === "ordersByCustomer")!;
        strict.match(orders.rowType, /"id": import\("@typed-sql\/core"\).Brand<bigint, "OrderId">/u);
        strict.match(orders.rowType, /"user_id": import\("@typed-sql\/core"\).Brand<bigint, "UserId">/u);
        strict.ok(orders.parameterType.includes('Brand<bigint, "UserId">'));
        strict.ok(
          result.hovers["app.ts"]!.find(({ from }) => from === files["app.ts"].indexOf("rows ="))!.content.includes(
            "OrderId",
          ),
        );
        const wrong = {
          ...files,
          "app.ts": files["app.ts"].replace("ordersByCustomer({ userId })", "ordersByCustomer({ userId: orderId })"),
        };
        strict.ok(
          workspace
            .analyze(dialect, wrong)
            .problems.some(
              ({ file, message }) => file === "app.ts" && message.includes("OrderId") && message.includes("UserId"),
            ),
        );
        const changed = {
          ...files,
          "schema/brands.ts": files["schema/brands.ts"]!.replaceAll('"UserId"', '"CustomerId"'),
        };
        const updated = workspace.analyze(dialect, changed);
        strict.ok(
          updated.queries.find(({ binding }) => binding === "ordersByCustomer")!.parameterType.includes("CustomerId"),
        );
        strict.ok(updated.problems.some(({ file, message }) => file === "app.ts" && message.includes("CustomerId")));
        const invalid = {
          ...files,
          "schema/brands.ts": files["schema/brands.ts"]!.replace("users: { id:", "users: { missing:"),
        };
        const rejected = workspace.analyze(dialect, invalid);
        strict.strictEqual(rejected.queries.length, 0);
        strict.ok(rejected.problems.some(({ file, code }) => file === "schema/brands.ts" && code === "PLAY208"));
      });
    }
    await it("never executes brand configuration expressions or accepts ambiguous object properties", () => {
      const files = lessonFiles("postgres", "brands", DEFAULT_SCHEMAS.postgres);
      for (const content of [
        "export const brands = (() => { globalThis.playgroundBrandExecuted = true; return {}; })();",
        "export const brands = { columns: {}, columns: {} };",
        "export const brands = { columns: { users: { id: `UserId` } } };",
        'export const brands = { ["columns"]: {} };',
        "export const brands = { extra: {} };",
      ]) {
        const result = workspace.analyze("postgres", { ...files, "schema/brands.ts": content });
        strict.strictEqual(result.queries.length, 0);
        strict.ok(result.problems.some(({ code }) => code === "PLAY208"));
        strict.strictEqual(Reflect.has(globalThis, "playgroundBrandExecuted"), false);
      }
      strict.deepStrictEqual(workspace.analyze("postgres", files).problems, []);
    });
  } finally {
    workspace.dispose();
  }
});
