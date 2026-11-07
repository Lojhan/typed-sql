import { fileURLToPath } from "node:url";
import { describe, it } from "poku";
import { createPackedNativeEditorConsumer } from "../helpers/packed-editor-consumer.js";
import { assertPackedEditorProject } from "../helpers/packed-editor-project.js";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const { NODE_PATH: _workspaceNodePath, ...isolatedEnvironment } = process.env;
const dialects = ["postgres", "mysql", "sqlite"] as const;

await describe("packed PostgreSQL, MySQL and SQLite editor consumers", async () => {
  await it("checks manifests, inferred types, diagnostics, reload and restart from isolated tarballs", async () => {
    const fixture = await createPackedNativeEditorConsumer(workspace, isolatedEnvironment, dialects);
    try {
      for (const dialect of dialects) await assertPackedEditorProject(fixture.consumer, dialect, isolatedEnvironment);
    } finally {
      await fixture.close();
    }
  });
});
