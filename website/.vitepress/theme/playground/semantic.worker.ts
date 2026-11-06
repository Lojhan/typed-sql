/// <reference types="vite/client" />

import type { EditorRequestEnvelope } from "./editor-protocol.js";
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
// Load the shipped driver-neutral type contracts, without importing runtime JS or a driver.
const grammarRuntime = import.meta.glob(
  "../../../../packages/{postgres,mysql,sqlite,sqlserver,duckdb}/dist/packages/*/src/*.d.ts",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);
for (const [path, source] of Object.entries(grammarRuntime))
  declarations[`/${path.split("/packages/")[1]!.split("/")[0]}/${path.split("/").pop()}`] = source as string;
const workspace = createSemanticWorkspace(declarations);

let snapshot = "";
self.onmessage = ({
  data,
}: MessageEvent<EditorRequestEnvelope | { revision: number; dialect: PlaygroundDialect; files: WorkspaceFiles }>) => {
  try {
    if (!validWorkspaceFiles(data.files)) throw new Error("Invalid workspace size or file paths.");
    const next = JSON.stringify([data.dialect, data.files]);
    if ("request" in data) {
      if (next !== snapshot) {
        workspace.analyze(data.dialect, data.files);
        snapshot = next;
      }
      self.postMessage({ id: data.id, value: workspace.interact(data.request) });
    } else {
      const result = workspace.analyze(data.dialect, data.files);
      snapshot = next;
      self.postMessage({ revision: data.revision, result });
    }
  } catch (error) {
    self.postMessage({
      ...("request" in data ? { id: data.id } : { revision: data.revision }),
      error: error instanceof Error ? error.message : "Analysis could not complete.",
    });
  }
};
