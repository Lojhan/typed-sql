import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { checkFile, compileSource, extractStaticQueries } from "../packages/compiler/src/index.js";
import { loadSchemaSnapshot } from "../packages/schema/src/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(testDirectory, "fixtures/success");
const schemaPath = resolve(fixtureDirectory, "schema.json");

await describe("TypeScript 7 compiler wrapper", async () => {
  await it("extracts static SQL and replaces interpolations with parameters", async () => {
    const source = 'import { sql as query } from "./generated/db/index.js";\nconst q = query`SELECT id FROM users WHERE id = ${id}`;';
    const extracted = extractStaticQueries(source);
    strict.strictEqual(extracted.length, 1);
    strict.strictEqual(extracted[0]?.sql, "SELECT id FROM users WHERE id = $1");
    strict.strictEqual(extracted[0]?.parameterCount, 1);
  });

  await it("injects an inferred row type without changing SQL text", async () => {
    const schema = await loadSchemaSnapshot(schemaPath);
    const source = 'import { sql } from "./generated/db/index.js";\nconst q = sql`SELECT id FROM users`;';
    const result = compileSource(source, schema);
    strict.deepStrictEqual(result.diagnostics, []);
    strict.ok(result.transformedSource.includes('sql<{ "id": number; }>`SELECT id FROM users`'));
  });

  await it("maps SQL diagnostics back to TypeScript source", async () => {
    const schema = await loadSchemaSnapshot(schemaPath);
    const source = 'import { sql } from "./generated/db/index.js";\nconst q = sql`SELECT missing FROM users`;';
    const result = compileSource(source, schema);
    strict.strictEqual(result.diagnostics[0]?.code, "TSQ101");
    strict.strictEqual(result.diagnostics[0]?.range.line, 2);
    strict.ok((result.diagnostics[0]?.range.column ?? 0) > 1);
  });

  await it("rejects the compile-failure acceptance fixture", async () => {
    const result = await checkFile({
      file: resolve(testDirectory, "fixtures/failure/query.ts"),
      schema: schemaPath,
      runTypeScript: false,
    });
    strict.deepStrictEqual(result.sqlDiagnostics.map((diagnostic) => diagnostic.code), ["TSQ101", "TSQ105", "TSQ100"]);
    strict.strictEqual(result.ok, false);
    strict.ok(result.sqlDiagnostics.every((diagnostic) => diagnostic.range.line >= 3));
  });

  await it("checks the acceptance fixture with the native TypeScript 7 compiler", async () => {
    const result = await checkFile({
      file: resolve(fixtureDirectory, "query.ts"),
      schema: schemaPath,
      project: resolve(fixtureDirectory, "tsconfig.json"),
    });
    strict.deepStrictEqual(result.sqlDiagnostics, []);
    strict.strictEqual(result.typeScript?.exitCode, 0, result.typeScript?.output);
    strict.strictEqual(result.ok, true);
  });
});
