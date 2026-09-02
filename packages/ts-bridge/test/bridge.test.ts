import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { analyzeSource as analyzeCompilerSource, SOURCE_ANALYSIS_FORMAT_VERSION } from "../../compiler/src/index.js";
import { type PostgresSchemaSnapshot, postgres } from "../../postgres/src/index.js";
import { loadSchemaSnapshot } from "../../schema/src/index.js";
import { analyzeSource, isStaticQueryPosition, queryAtPosition } from "../src/index.js";
import { NativePreviewTypeScriptBridge, TYPESCRIPT_PREVIEW_VERSION } from "../src/native-preview.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(testDirectory, "../../..");
const fixtureDirectory = join(workspaceDirectory, "test", "fixtures", "success");
const queryFile = join(fixtureDirectory, "query.ts");
const secondQueryFile = join(fixtureDirectory, "query-two.ts");
const projectFile = join(fixtureDirectory, "tsconfig.json");
const secondProjectFile = join(fixtureDirectory, "tsconfig.two.json");
const schemaFile = join(fixtureDirectory, "schema.json");

await describe("TypeScript 7 editor bridge", async () => {
  const source = await readFile(queryFile, "utf8");
  const schema = await loadSchemaSnapshot(schemaFile);
  const analysis = analyzeSource(source, schema as PostgresSchemaSnapshot, postgres());

  await it("creates an editor-neutral inferred query and binding range", () => {
    const query = analysis.queries[0];
    strict.strictEqual(query?.rowType, '{ "id": number; "name": string; "age": bigint | null; }');
    strict.strictEqual(query?.parameterType, "readonly []");
    strict.strictEqual(query?.queryType, 'Query<{ "id": number; "name": string; "age": bigint | null; }, readonly []>');
    strict.strictEqual(query?.binding?.name, "query");
    strict.ok(
      analysis.transformedSource.includes('sql<{ "id": number; "name": string; "age": bigint | null; }, readonly []>`'),
    );
    strict.strictEqual(queryAtPosition(analysis, query?.binding?.range.start ?? -1), query);
    strict.deepStrictEqual(
      analysis,
      analyzeCompilerSource(
        {
          formatVersion: SOURCE_ANALYSIS_FORMAT_VERSION,
          source: { id: "inline", text: source },
        },
        { schema: schema as PostgresSchemaSnapshot, dialect: postgres() },
      ),
    );
  });

  await it("maps cumulative append fragment overlays without producing partial-query diagnostics", () => {
    const composedSource = [
      'import { sql } from "@typed-sql/postgres";',
      "const base = sql`SELECT users.id, users.name FROM users`;",
      "const query = sql.append(",
      "  base,",
      "  sql.fragment` WHERE 1 = 1`,",
      "  sql.fragment` AND users.id >= ${1}`,",
      ");",
    ].join("\n");
    const composed = analyzeSource(composedSource, schema as PostgresSchemaSnapshot, postgres());
    strict.deepStrictEqual(composed.diagnostics, []);
    strict.strictEqual(composed.insertions.length, 3);
    strict.ok(composed.transformedSource.includes("sql.fragment<readonly [number]>` AND users.id"));
    strict.ok(
      composed.insertions.every(
        (insertion, index, values) => index === 0 || insertion.position >= (values[index - 1]?.position ?? 0),
      ),
    );
  });

  await it("distinguishes static SQL tokens from runtime interpolation expressions", () => {
    const parameterizedSource = [
      'import { sql } from "@typed-sql/postgres";',
      'const name = "Ada";',
      "const query = sql`SELECT users.id FROM users WHERE users.name = ${name}`;",
    ].join("\n");
    const parameterized = analyzeSource(parameterizedSource, schema as PostgresSchemaSnapshot, postgres());
    const query = parameterized.queries[0];
    if (query === undefined) throw new Error("Expected a parameterized query");
    strict.strictEqual(query.interpolationRanges.length, 1);
    strict.strictEqual(isStaticQueryPosition(query, parameterizedSource.indexOf("users.id")), true);
    strict.strictEqual(isStaticQueryPosition(query, parameterizedSource.lastIndexOf("name")), false);
  });

  await it("maps conditional structural fragment overlays as complete SQL variants", () => {
    const structuralSource = [
      'import { sql } from "@typed-sql/postgres";',
      "interface Selection { readonly age: boolean }",
      "function users<const Select extends Selection>(select: Select) {",
      "  return sql`SELECT users.id${select.age ? sql.fragment`, users.age` : sql.empty} FROM users`;",
      "}",
    ].join("\n");
    const structural = analyzeSource(structuralSource, schema as PostgresSchemaSnapshot, postgres());
    strict.deepStrictEqual(structural.diagnostics, []);
    strict.ok(structural.transformedSource.includes('sql.__typed<Select["age"] extends true'));
    strict.strictEqual(structural.insertions.length, 2);
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

  await it("applies unopened multi-file overlays in one project snapshot", async () => {
    const secondSource = await readFile(secondQueryFile, "utf8");
    const secondAnalysis = analyzeSource(secondSource, schema as PostgresSchemaSnapshot, postgres());
    const bridge = NativePreviewTypeScriptBridge.spawn({ cwd: workspaceDirectory });
    try {
      const inspections = await bridge.inspectFiles([
        { fileName: queryFile, projectFile, analysis },
        { fileName: secondQueryFile, projectFile: secondProjectFile, analysis: secondAnalysis },
      ]);
      strict.strictEqual(inspections.size, 2);
      strict.ok(inspections.get(queryFile)?.[0]?.typeText.includes("age: bigint | null"));
      strict.ok(
        inspections.get(secondQueryFile)?.[0]?.typeText.includes("user_id: number"),
        inspections.get(secondQueryFile)?.[0]?.typeText,
      );
      strict.ok(!inspections.get(secondQueryFile)?.[0]?.typeText.includes("unknown"));
    } finally {
      await bridge.close();
    }
  });
});
