import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { type PostgresSchemaSnapshot, postgres } from "../../postgres/src/index.js";
import { loadSchemaSnapshot } from "../../schema/src/index.js";
import {
  analyzeSource,
  createTypeScriptBackend,
  TYPESCRIPT_BACKEND_ADAPTERS,
  TYPESCRIPT_SUPPORT_POLICY,
} from "../src/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(testDirectory, "../../..");
const fixtureDirectory = join(workspaceDirectory, "test", "fixtures", "success");
const queryFile = join(fixtureDirectory, "query.ts");
const projectFile = join(fixtureDirectory, "tsconfig.json");
const source = await readFile(queryFile, "utf8");
const schema = (await loadSchemaSnapshot(join(fixtureDirectory, "schema.json"))) as PostgresSchemaSnapshot;
const analysis = analyzeSource(source, schema, postgres(), undefined, { sourceId: queryFile });

await describe("version-specific TypeScript backend", async () => {
  await it("publishes the exact supported adapter identity and opaque project handles", async () => {
    const backend = createTypeScriptBackend({ cwd: workspaceDirectory });
    try {
      strict.deepStrictEqual(TYPESCRIPT_BACKEND_ADAPTERS, [backend.identity]);
      strict.strictEqual(backend.identity.id, "typescript-7.1-native-preview");
      strict.strictEqual(backend.identity.line, TYPESCRIPT_SUPPORT_POLICY.previewBackend.line);
      strict.strictEqual(backend.identity.version, TYPESCRIPT_SUPPORT_POLICY.previewBackend.exactVersion);
      strict.ok(Object.isFrozen(backend.identity));
      strict.ok(Object.isFrozen(TYPESCRIPT_BACKEND_ADAPTERS));

      const project = await backend.loadProject({ openFiles: [queryFile], projectFiles: [projectFile] });
      strict.strictEqual(project.backend, backend.identity);
      strict.deepStrictEqual(project.openFiles, [queryFile]);
      strict.deepStrictEqual(project.projectFiles, [projectFile]);
      strict.ok(Object.isFrozen(project));
      const inspections = await backend.inspectFiles(project, [{ fileName: queryFile, projectFile, analysis }]);
      strict.ok(inspections.get(queryFile)?.[0]?.typeText.includes("id: number"));
      strict.ok(!inspections.get(queryFile)?.[0]?.typeText.includes("unknown"));
      await backend.disposeProject(project);
      await strict.rejects(() => backend.inspectFiles(project, []), /unknown or disposed/u);
      await backend.disposeProject(project);
    } finally {
      await backend.close();
    }
  });

  await it("validates project membership and releases outstanding projects on close", async () => {
    const backend = createTypeScriptBackend({ cwd: workspaceDirectory });
    const project = await backend.loadProject({ openFiles: [queryFile], projectFiles: [projectFile] });
    await strict.rejects(
      () => backend.inspectFiles(project, [{ fileName: join(fixtureDirectory, "other.ts"), analysis }]),
      /not part of the loaded project/u,
    );
    await backend.close();
    await backend.close();
    await strict.rejects(() => backend.loadProject({ openFiles: [queryFile] }), /backend is closed/u);
  });
});
