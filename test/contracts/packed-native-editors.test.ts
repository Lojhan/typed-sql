import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "poku";
import { createPackedNativeEditorConsumer } from "../helpers/packed-editor-consumer.js";
import { assertPackedEditorProject } from "../helpers/packed-editor-project.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { NODE_PATH: _workspaceNodePath, ...isolatedEnvironment } = process.env;
await describe("packed native grammar editors", async () => {
  await it("checks SQL Server and DuckDB through installed driver-free language server artifacts", async () => {
    const fixture = await createPackedNativeEditorConsumer(workspace, isolatedEnvironment);
    try {
      for (const dialect of ["sqlserver", "duckdb"] as const)
        await assertPackedEditorProject(fixture.consumer, dialect, isolatedEnvironment);
    } finally {
      await fixture.close();
    }
  });
});
