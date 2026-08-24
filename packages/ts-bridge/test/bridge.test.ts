import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { loadSchemaSnapshot } from "../../schema/src/index.js";
import { postgres, type PostgresSchemaSnapshot } from "../../postgres/src/index.js";
import { analyzeSource, queryAtPosition } from "../src/index.js";
import {
  NativePreviewTypeScriptBridge,
  TYPESCRIPT_PREVIEW_VERSION,
} from "../src/native-preview.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(testDirectory, "../../..");
const fixtureDirectory = join(workspaceDirectory, "test", "fixtures", "success");
const queryFile = join(fixtureDirectory, "query.ts");
const projectFile = join(fixtureDirectory, "tsconfig.json");
const schemaFile = join(fixtureDirectory, "schema.json");

await describe("TypeScript 7 editor bridge", async () => {
  const source = await readFile(queryFile, "utf8");
  const schema = await loadSchemaSnapshot(schemaFile);
  const analysis = analyzeSource(source, schema as PostgresSchemaSnapshot, postgres());

  await it("creates an editor-neutral inferred query and binding range", () => {
    const query = analysis.queries[0];
    strict.strictEqual(query?.rowType, '{ "id": number; "name": string; "age": bigint | null; }');
    strict.strictEqual(query?.queryType, 'Query<{ "id": number; "name": string; "age": bigint | null; }>');
    strict.strictEqual(query?.binding?.name, "query");
    strict.ok(analysis.transformedSource.includes('sql<{ "id": number; "name": string; "age": bigint | null; }>`'));
    strict.strictEqual(queryAtPosition(analysis, query?.binding?.range.start ?? -1), query);
  });

  await it("gets the authoritative Query row from the published TypeScript preview API", async () => {
    const bridge = NativePreviewTypeScriptBridge.spawn({ cwd: workspaceDirectory });
    try {
      const inspections = await bridge.inspectFile({ fileName: queryFile, projectFile, analysis });
      strict.strictEqual(TYPESCRIPT_PREVIEW_VERSION, "7.1.0-dev.20260824.1");
      strict.strictEqual(inspections.length, 1);
      strict.ok(inspections[0]?.typeText.startsWith("Query<"));
      strict.ok(inspections[0]?.typeText.includes("id: number"));
      strict.ok(inspections[0]?.typeText.includes("age: bigint | null"));
      strict.ok(!inspections[0]?.typeText.includes("unknown"));
    } finally {
      await bridge.close();
    }
  });
});
