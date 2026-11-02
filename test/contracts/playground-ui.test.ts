import { describe, it, strict } from "poku";
import { highlightSource } from "../../website/.vitepress/theme/playground/type-highlighting.js";
import { validWorkspaceFiles, WORKSPACE_LIMITS } from "../../website/.vitepress/theme/playground/workspace.js";
import { queryAtPosition } from "../../website/.vitepress/theme/playground/workspace-selection.js";
import {
  BROWSER_COMPILER_SETTINGS,
  panelShortcut,
  WORKSPACE_CONFIG_PATH,
  workspaceConfigSource,
} from "../../website/.vitepress/theme/playground/workspace-ui.js";

await describe("playground editor controls", async () => {
  await it("shows the shared analysis settings and actual files without adding generated config to the project", () => {
    const files = { "queries/a.sql": "SELECT 1;", "app.ts": "export {};", "schema/tables.sql": "" };
    const before = { ...files };
    const source = workspaceConfigSource("mysql", files);
    const config = JSON.parse(
      source.slice(source.indexOf("export default ") + "export default ".length).replace(/;\s*$/u, ""),
    );
    strict.strictEqual(config.dialect, "mysql");
    strict.strictEqual(config.sqlModule, "@typed-sql/mysql");
    strict.deepStrictEqual(config.sqlFiles, ["queries/a.sql", "schema/tables.sql"]);
    strict.deepStrictEqual(config.typescriptFiles, ["app.ts"]);
    strict.deepStrictEqual(config.compilerOptions, BROWSER_COMPILER_SETTINGS);
    strict.deepStrictEqual(config.limits, WORKSPACE_LIMITS);
    strict.deepStrictEqual(files, before);
    strict.ok(!validWorkspaceFiles({ ...files, [WORKSPACE_CONFIG_PATH]: source }));
  });
  await it("handles Cmd+B and Cmd+Alt+B, including macOS Option-key characters", () => {
    const event = {
      key: "b",
      code: "KeyB",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
    };
    strict.strictEqual(panelShortcut(event), "files");
    strict.strictEqual(panelShortcut({ ...event, key: "∫", altKey: true }), "inspector");
    strict.strictEqual(panelShortcut({ ...event, metaKey: false, ctrlKey: true }), "files");
    for (const ignored of [
      { ...event, metaKey: false },
      { ...event, shiftKey: true },
      { ...event, isComposing: true },
      { ...event, key: "s", code: "KeyS" },
    ])
      strict.strictEqual(panelShortcut(ignored), undefined);
  });
  await it("selects the query under the cursor without crossing files", () => {
    const first = { file: "queries/a.sql", binding: "first", sourceStart: 0, sourceEnd: 15 };
    const second = { file: "queries/a.sql", binding: "second", sourceStart: 17, sourceEnd: 40 };
    const other = { ...first, file: "queries/b.sql" };
    strict.strictEqual(queryAtPosition([first, second, other], first.file, 25), second);
    strict.strictEqual(queryAtPosition([first, second, other], "app.ts", 5), undefined);
    strict.strictEqual(queryAtPosition([first, second], first.file, 16), undefined);
  });
  await it("highlights SQL keywords, values and comments while preserving exact source", () => {
    for (const dialect of ["postgres", "mysql", "sqlite"] as const) {
      const source = "-- A query\nSELECT 'active' AS status, 42 AS id;";
      const tokens = highlightSource(source, "sql", dialect);
      strict.strictEqual(tokens.map(({ text }) => text).join(""), source);
      strict.ok(tokens.some(({ text, className }) => text === "SELECT" && className.includes("tok-keyword")));
      strict.ok(tokens.some(({ text, className }) => text === "'active'" && className.includes("tok-string")));
      strict.ok(tokens.some(({ className }) => className.includes("tok-comment")));
    }
  });
});
