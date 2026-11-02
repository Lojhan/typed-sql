import { describe, it, strict } from "poku";
import {
  closeEditorFile,
  createPane,
  dropEditorFile,
  editorPanes,
  isCloseFileShortcut,
  removePane,
} from "../../website/.vitepress/theme/playground/editor-layout.js";
import type {
  EditorCompletion,
  EditorCompletionEdits,
  EditorLocation,
} from "../../website/.vitepress/theme/playground/editor-protocol.js";
import { DEFAULT_SCHEMAS } from "../../website/.vitepress/theme/playground/playground.js";
import { createTestWorkspace } from "../helpers/playground-workspace.js";

await describe("playground editor interactions", async () => {
  const workspace = createTestWorkspace();
  try {
    await it("navigates imports to original TS and SQL sources", () => {
      const query =
        'import { sql } from "@typed-sql/postgres"; export const accountById = (id: bigint) => sql`SELECT id, email FROM users WHERE id = ${id}`; export const afterQuery = 1;';
      const source =
        'import { accountById, afterQuery } from "./queries/account.ts"; import accountSql from "./queries/account.sql"; accountById(1n); afterQuery; accountSql(1n);';
      workspace.analyze("postgres", {
        "schema.sql": DEFAULT_SCHEMAS.postgres,
        "queries/account.ts": query,
        "queries/account.sql": "SELECT id, email FROM users WHERE id = $1;",
        "app.ts": source,
      });
      for (const name of ["accountById", "afterQuery"]) {
        const target = workspace.interact({
          kind: "definition",
          file: "app.ts",
          position: source.lastIndexOf(name) + 1,
        }) as EditorLocation;
        strict.strictEqual(target.file, "queries/account.ts");
        strict.strictEqual(query.slice(target.from, target.to), name);
      }
      const sql = workspace.interact({
        kind: "definition",
        file: "app.ts",
        position: source.lastIndexOf("accountSql") + 1,
      }) as EditorLocation;
      strict.strictEqual(sql.file, "queries/account.sql");
      strict.ok(sql.to > sql.from);
      strict.strictEqual(workspace.interact({ kind: "definition", file: "missing.ts", position: 0 }), undefined);
    });
    await it("completes inferred result members and returns atomic auto-import edits", () => {
      const base = {
        "schema.sql": DEFAULT_SCHEMAS.postgres,
        "queries/account.ts":
          'import { sql } from "@typed-sql/postgres"; export const accountById = (id: bigint) => sql`SELECT id, email FROM users WHERE id = ${id}`;',
      };
      const source = "accountB";
      workspace.analyze("postgres", { ...base, "app.ts": source });
      const entries = workspace.interact({
        kind: "completions",
        file: "app.ts",
        position: source.length,
      }) as EditorCompletion[];
      const entry = entries.find((item) => item.name === "accountById" && item.source);
      strict.ok(entry, JSON.stringify(entries.filter((item) => item.source)));
      const details = workspace.interact({
        kind: "completionEdits",
        file: "app.ts",
        position: source.length,
        entry: entry!,
      }) as EditorCompletionEdits;
      strict.ok(details.edits.some((edit) => edit.insert.includes('from "./queries/account.ts"')));
      const completed = details.edits.reduceRight(
        (text, edit) => text.slice(0, edit.from) + edit.insert + text.slice(edit.to),
        "accountById",
      );
      const checked = workspace.analyze("postgres", { ...base, "app.ts": `${completed}(1n);` });
      strict.deepStrictEqual(checked.problems, []);
      const member = 'import { accountById } from "./queries/account.ts"; const q = accountById(1n); q.';
      workspace.analyze("postgres", { ...base, "app.ts": member });
      const properties = workspace.interact({
        kind: "completions",
        file: "app.ts",
        position: member.length,
      }) as EditorCompletion[];
      strict.ok(properties.some((item) => item.name === "segments"));
      strict.ok(!entries.some((item) => item.source?.startsWith("/core/")));
      workspace.analyze("postgres", { "schema.sql": DEFAULT_SCHEMAS.postgres, "app.ts": "sq" });
      const grammarEntries = workspace.interact({
        kind: "completions",
        file: "app.ts",
        position: 2,
      }) as EditorCompletion[];
      const tag = grammarEntries.find((item) => item.name === "sql" && item.grammarImport)!;
      strict.ok(tag);
      const tagEdits = workspace.interact({
        kind: "completionEdits",
        file: "app.ts",
        position: 2,
        entry: tag,
      }) as EditorCompletionEdits;
      strict.strictEqual(tagEdits.edits[0]?.insert, 'import { sql } from "@typed-sql/postgres";\n');
      strict.ok(!grammarEntries.some((item) => item.data?.fileName && !item.data.fileName.startsWith("/workspace/")));
    });
    await it("maps completion edits after synthesized SQL type arguments back to source", () => {
      const source = 'import { sql } from "@typed-sql/postgres"; const q = sql`SELECT id FROM users`; helperV';
      workspace.analyze("postgres", {
        "schema.sql": DEFAULT_SCHEMAS.postgres,
        "helper.ts": "export const helperValue = 42;",
        "app.ts": source,
      });
      const entries = workspace.interact({
        kind: "completions",
        file: "app.ts",
        position: source.length,
      }) as EditorCompletion[];
      const entry = entries.find((item) => item.name === "helperValue")!;
      strict.ok(entry);
      const details = workspace.interact({
        kind: "completionEdits",
        file: "app.ts",
        position: source.length,
        entry,
      }) as EditorCompletionEdits;
      strict.ok(details.edits.length);
      strict.ok(details.edits.every((edit) => edit.to <= source.length));
    });
  } finally {
    workspace.dispose();
  }
  await it("splits in four directions, moves tabs, collapses empty panes, and reorders tabs", () => {
    for (const edge of ["left", "right", "top", "bottom"] as const) {
      const initial = createPane("app.ts");
      const result = dropEditorFile(initial, initial.id, "query.sql", edge);
      strict.strictEqual(editorPanes(result.layout).length, 2);
      strict.strictEqual(
        result.layout.kind === "split" && result.layout.axis,
        edge === "left" || edge === "right" ? "horizontal" : "vertical",
      );
      strict.strictEqual(editorPanes(result.layout).find((pane) => pane.id === result.active)?.file, "query.sql");
      const moved = dropEditorFile(result.layout, initial.id, "query.sql", "center", result.active);
      strict.strictEqual(editorPanes(moved.layout).length, 1);
      strict.deepStrictEqual(editorPanes(moved.layout)[0]?.tabs, ["app.ts", "query.sql"]);
      dropEditorFile(moved.layout, initial.id, "query.sql", "center", initial.id, "app.ts");
      strict.deepStrictEqual(initial.tabs, ["query.sql", "app.ts"]);
      strict.strictEqual(removePane(moved.layout, initial.id), undefined);
    }
  });
  await it("closes only the requested tab and preserves an empty final pane", () => {
    const pane = createPane("app.ts", ["app.ts", "query.ts"]);
    closeEditorFile(pane, pane.id, "app.ts");
    strict.strictEqual(pane.file, "query.ts");
    strict.deepStrictEqual(pane.tabs, ["query.ts"]);
    const empty = closeEditorFile(pane, pane.id, "query.ts");
    strict.strictEqual(editorPanes(empty).length, 1);
    strict.strictEqual(pane.file, "");
    const keyboard = {
      key: "w",
      code: "KeyW",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
    };
    strict.ok(isCloseFileShortcut(keyboard));
    strict.ok(isCloseFileShortcut({ ...keyboard, metaKey: false, ctrlKey: true, altKey: true }));
    strict.ok(!isCloseFileShortcut({ ...keyboard, shiftKey: true }));
    strict.ok(!isCloseFileShortcut({ ...keyboard, isComposing: true }));
  });
});
