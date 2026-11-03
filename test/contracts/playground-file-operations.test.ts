import { describe, it, strict } from "poku";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.js";
import {
  entryPathError,
  renameWorkspaceEntry,
  treeMoveDestination,
  validWorkspaceFolders,
  workspaceFolders,
} from "../../website/.vitepress/theme/playground/file-operations.js";
import {
  decodeSharedWorkspace,
  restorePlaygroundState,
} from "../../website/.vitepress/theme/playground/workspace-storage.js";
import { WORKSPACE_CONFIG_PATH } from "../../website/.vitepress/theme/playground/workspace-ui.js";
import { createTestWorkspace } from "../helpers/playground-workspace.js";

await describe("editor file operations", async () => {
  await it("renames SQL imports and entire query directories without losing inference", () => {
    const service = createTestWorkspace();
    try {
      const files = commerceFiles("postgres");
      const renamed = renameWorkspaceEntry(files, ["empty/nested"], "queries/revenue.sql", "queries/sales.sql", false);
      strict.match(renamed.files["app.ts"]!, /\.\/queries\/sales\.sql/u);
      strict.ok(!Object.hasOwn(renamed.files, "queries/revenue.sql"));
      strict.deepStrictEqual(service.analyze("postgres", renamed.files).problems, []);
      const moved = renameWorkspaceEntry(renamed.files, renamed.folders, "queries", "src/queries", true);
      strict.match(moved.files["app.ts"]!, /\.\/src\/queries\/sales\.sql/u);
      strict.ok(Object.hasOwn(moved.files, "src/queries/account.ts"));
      strict.ok(moved.folders.includes("empty/nested"));
      strict.deepStrictEqual(service.analyze("postgres", moved.files).problems, []);
    } finally {
      service.dispose();
    }
  });
  await it("updates outgoing imports, re-exports and dynamic imports without editing ordinary strings or comments", () => {
    const files = {
      "a.ts":
        'import x from "./b.sql"; export { y } from "./lib/y"; const p = import("./lib/y.ts"); const s = "./b.sql"; // import x from "./b.sql"',
      "b.sql": "SELECT 1;",
      "lib/y.ts": "export const y = 1;",
    };
    const result = renameWorkspaceEntry(files, [], "a.ts", "src/a.ts", false);
    strict.strictEqual(
      result.files["src/a.ts"],
      'import x from "../b.sql"; export { y } from "../lib/y"; const p = import("../lib/y.ts"); const s = "./b.sql"; // import x from "./b.sql"',
    );
    strict.strictEqual(files["a.ts"].startsWith('import x from "./b.sql"'), true);
  });
  await it("rejects collisions, recursive moves and reserved paths before mutating", () => {
    const files = { "src/a.ts": "", "b.ts": "" };
    strict.ok(entryPathError(files, [], "src", false));
    strict.ok(entryPathError(files, [], "b.ts/nested", true));
    strict.ok(entryPathError(files, ["empty"], "empty", false));
    strict.throws(() => renameWorkspaceEntry(files, [], "src", "src/nested", true), /inside itself/u);
    strict.throws(() => renameWorkspaceEntry(files, [], "src/a.ts", "b.ts", false), /already exists/u);
    strict.ok(entryPathError(files, [], "playground.config.ts", false));
    strict.throws(() => renameWorkspaceEntry(files, [], WORKSPACE_CONFIG_PATH, "config.ts", false), /read only/u);
    strict.ok(!entryPathError(files, [], "src/a.ts", false, "src/a.ts"));
  });
  await it("plans folder and root moves while rejecting conflicts, self-nesting, and protected entries", () => {
    const files = { "queries/a.ts": "", "queries/nested/b.sql": "", "a.ts": "" };
    const folders = ["archive", "empty"];
    strict.deepStrictEqual(treeMoveDestination(files, folders, { path: "queries/a.ts", folder: false }, "archive"), {
      path: "archive/a.ts",
    });
    strict.deepStrictEqual(treeMoveDestination(files, folders, { path: "queries/nested", folder: true }, ""), {
      path: "nested",
    });
    strict.deepStrictEqual(treeMoveDestination(files, folders, { path: "empty", folder: true }, "archive"), {
      path: "archive/empty",
    });
    strict.deepStrictEqual(treeMoveDestination(files, folders, { path: "queries/a.ts", folder: false }, "queries"), {});
    strict.match(
      treeMoveDestination(files, folders, { path: "queries/a.ts", folder: false }, "").error!,
      /already exists/u,
    );
    strict.match(
      treeMoveDestination(files, folders, { path: "queries", folder: true }, "queries/nested").error!,
      /inside itself/u,
    );
    strict.match(
      treeMoveDestination(files, folders, { path: WORKSPACE_CONFIG_PATH, folder: false }, "archive").error!,
      /read only/u,
    );
    strict.match(
      treeMoveDestination(files, folders, { path: "queries/a.ts", folder: false }, "missing").error!,
      /no longer exists/u,
    );
    const moved = renameWorkspaceEntry(files, folders, "queries/nested", "nested", true);
    strict.ok(Object.hasOwn(moved.files, "nested/b.sql"));
    strict.ok(moved.folders.includes("queries"));
  });
  await it("preserves empty directories and entirely empty workspaces across storage and sharing", () => {
    const files = {};
    const folders = ["queries/reports", "schema"];
    const restored = restorePlaygroundState({
      version: 2,
      dialect: "postgres",
      workspaces: { postgres: { files, folders } },
    });
    strict.deepStrictEqual(restored.workspaces.postgres.files, {});
    strict.deepStrictEqual(restored.workspaces.postgres.folders, folders);
    strict.deepStrictEqual(decodeSharedWorkspace({ dialect: "postgres", files, folders })?.workspace.folders, folders);
    strict.deepStrictEqual(workspaceFolders([], folders), ["queries", "queries/reports", "schema"]);
    strict.ok(!validWorkspaceFolders(["../escape"], files));
    strict.ok(!validWorkspaceFolders(["b.ts/child"], { "b.ts": "" }));
  });
});
