import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { TextDocument } from "vscode-languageserver-textdocument";
import { TypedSqlLanguageService } from "../src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = join(root, "test/fixtures/success");
const service = new TypedSqlLanguageService(root, {
  configPath: join(root, "e2e/postgres/typed-sql.config.ts"),
  schemaPath: join(fixture, "schema.json"),
  projectFile: join(fixture, "tsconfig.json"),
  nativePreview: false,
});
const document = (source: string, version = 1) =>
  TextDocument.create(pathToFileURL(join(fixture, "standalone.sql")).href, "sql", version, source);
await describe("standalone SQL intelligence", async () => {
  try {
    await it("uses grammar analysis for query types and ordered parameters", async () => {
      const current = document("SELECT id, name FROM users WHERE id = $1");
      const hover = await service.hover(current, { line: 0, character: 8 });
      const text = JSON.stringify(hover);
      strict.match(text, /number/u);
      strict.match(text, /readonly \[number\]/u);
      strict.deepEqual(await service.diagnostics(current), []);
    });
    await it("offers schema columns and navigates to the configured snapshot", async () => {
      const current = document("SELECT usr_.name FROM users AS usr_", 2);
      const items = await service.completions(current, current.positionAt("SELECT usr_.".length));
      strict.deepEqual(items.map((item) => item.label).sort(), ["age", "id", "name"]);
      const definition = await service.definition(current, current.positionAt(current.getText().indexOf("users") + 1));
      strict.equal((definition as { uri: string }).uri, pathToFileURL(join(fixture, "schema.json")).href);
    });
    await it("keeps original UTF-16 ranges for emoji, CRLF, and template punctuation", async () => {
      const current = document("SELECT '😀 `${x}`' AS emoji,\r\n  missing FROM users", 3);
      const diagnostics = await service.diagnostics(current);
      const missing = diagnostics.find((item) => item.code === "TSQ101");
      strict.deepEqual(missing?.range, { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } });
      strict.equal(await service.hover(current, { line: 1, character: 3 }), undefined);
    });
  } finally {
    await service.close();
  }
});
