/// <reference types="vite/client" />

import type { PlaygroundDialect } from "./playground.js";
import { createSemanticWorkspace } from "./semantic-service.js";
import { validWorkspaceFiles, type WorkspaceFiles } from "./workspace.js";

const core = import.meta.glob("../../../../packages/core/src/*.ts", { query: "?raw", import: "default", eager: true });
const libraries = import.meta.glob("../../../node_modules/@typed-sql/browser-typescript/lib/lib.*.d.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const declarations: Record<string, string> = {
  "/grammar.d.ts": 'import type { SqlTag } from "./core/query"; export declare const sql: SqlTag;',
};
for (const [path, source] of Object.entries(core)) declarations[`/core/${path.split("/").pop()}`] = source as string;
for (const [path, source] of Object.entries(libraries))
  declarations[`/lib/${path.split("/").pop()}`] = source as string;
const workspace = createSemanticWorkspace(declarations);

self.onmessage = ({ data }: MessageEvent<{ revision: number; dialect: PlaygroundDialect; files: WorkspaceFiles }>) => {
  try {
    if (!validWorkspaceFiles(data.files))
      throw new Error("Use up to 40 .ts/.sql files, 40,000 characters each, and 200,000 characters total.");
    self.postMessage({ revision: data.revision, result: workspace.analyze(data.dialect, data.files) });
  } catch (error) {
    self.postMessage({
      revision: data.revision,
      error: error instanceof Error ? error.message : "Analysis could not complete.",
    });
  }
};
