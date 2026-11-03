import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, strict } from "poku";
import { COMMERCE_SCHEMAS } from "../../examples/shared/commerce-schema.js";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.js";
import { PREVIOUS_EXAMPLES } from "../../website/.vitepress/theme/playground/previous-examples.js";
import {
  defaultPlaygroundState,
  restorePlaygroundState,
} from "../../website/.vitepress/theme/playground/workspace-storage.js";
import { createTestWorkspace } from "../helpers/playground-workspace.js";

await describe("one commerce model across docs and playground", async () => {
  const state = defaultPlaygroundState();
  const service = createTestWorkspace();
  try {
    for (const dialect of ["postgres", "mysql", "sqlite"] as const) {
      await it(`${dialect} opens every video scenario as a checked default workspace`, () => {
        strict.strictEqual(state.workspaces[dialect].example, "commerce");
        const files = commerceFiles(dialect);
        strict.deepStrictEqual(state.workspaces[dialect].files, files);
        const result = service.analyze(dialect, files);
        strict.deepStrictEqual(result.problems, []);
        strict.strictEqual(result.queries.length, 8);
        for (const binding of [
          "accountById",
          "revenueByCustomer",
          "orderDocument",
          "insertProducts",
          "insertPair",
          "recordAudit",
          "catalog",
          "markShipped",
        ]) {
          const query = result.queries.find((query) => query.binding === binding);
          strict.ok(query, `${dialect} is missing ${binding}`);
          strict.doesNotMatch(query!.rowType, /\bany\b/u);
          strict.doesNotMatch(query!.parameterType, /\bany\b/u);
        }
        for (const table of ["users", "teams", "memberships", "products", "orders", "order_items", "audit_events"])
          strict.match(COMMERCE_SCHEMAS[dialect], new RegExp(`CREATE TABLE ${table} \\(`, "u"));
        const ddl = readFileSync(new URL(`../../examples/${dialect}/schema/001-schema.sql`, import.meta.url), "utf8");
        strict.ok(ddl.includes(COMMERCE_SCHEMAS[dialect].trim()), "runnable and playground DDL drifted");
        const broken = { ...files, "app.ts": files["app.ts"]!.replace("accountById(42n)", 'accountById("42")') };
        strict.ok(
          service.analyze(dialect, broken).problems.some(({ code, file }) => code === "TS2345" && file === "app.ts"),
        );
      });
      await it(`${dialect} upgrades only unchanged shipped starters`, () => {
        const old = PREVIOUS_EXAMPLES.find((example) => example.dialect === dialect && example.lesson === "workspace")!;
        const saved = { version: 2, dialect, workspaces: { [dialect]: { files: old.files, example: "workspace" } } };
        strict.strictEqual(restorePlaygroundState(saved).workspaces[dialect].example, "commerce");
        const files = { ...old.files, "app.ts": old.files["app.ts"] + "\n// My own changes\n" };
        const edited = restorePlaygroundState({ ...saved, workspaces: { [dialect]: { files, example: "workspace" } } });
        strict.deepStrictEqual(edited.workspaces[dialect].files, files);
        strict.strictEqual(edited.workspaces[dialect].example, "custom");
      });
    }
    await it("executes the complete strict SQLite schema with working relationships", () => {
      const database = new DatabaseSync(":memory:");
      try {
        database.exec(readFileSync(new URL("../../examples/sqlite/schema/001-schema.sql", import.meta.url), "utf8"));
        const row = database
          .prepare("SELECT u.email, o.total_cents FROM users u JOIN orders o ON o.user_id = u.id WHERE u.id = 1")
          .get();
        strict.strictEqual(row!.email, "alice@example.com");
        strict.strictEqual(row!.total_cents, 12500);
        strict.throws(
          () => database.exec("INSERT INTO memberships (user_id, team_id, role) VALUES (999, 1, 'member')"),
          /FOREIGN KEY/u,
        );
      } finally {
        database.close();
      }
    });
  } finally {
    service.dispose();
  }
});
