import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { TextDocument } from "vscode-languageserver-textdocument";
import { TypedSqlLanguageService } from "../src/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(testDirectory, "../../..");
const fixtureDirectory = join(workspaceDirectory, "test", "fixtures", "success");
const schemaFile = join(fixtureDirectory, "schema.json");
const configFile = join(workspaceDirectory, "e2e", "postgres", "typed-sql.config.ts");
const projectFile = join(fixtureDirectory, "tsconfig.json");
const source = `
  import { sql } from "@typed-sql/postgres";
  const query = sql\`SELECT user.id, user.name FROM users AS user\`;
`;

function document(name: string, text = source, version = 1): TextDocument {
  return TextDocument.create(pathToFileURL(join(fixtureDirectory, name)).href, "typescript", version, text);
}

function positionAt(text: string, offset: number): { readonly line: number; readonly character: number } {
  return document("position.ts", text).positionAt(offset);
}

await describe("typed-sql language service", async () => {
  const service = new TypedSqlLanguageService(workspaceDirectory, {
    configPath: configFile,
    schemaPath: schemaFile,
    projectFile,
    nativePreview: false,
    maxCacheEntries: 2,
  });

  await it("provides schema-aware SQL completion and snapshot definitions", async () => {
    const current = document("completion.ts");
    const qualifierOffset = source.indexOf("user.name") + "user.".length;
    const completions = await service.completions(current, positionAt(source, qualifierOffset));
    strict.deepStrictEqual(completions.map((item) => item.label).sort(), ["age", "id", "name"]);
    strict.ok(completions.find((item) => item.label === "age")?.detail?.includes("nullable"));
    const tableOffset = source.indexOf("users AS") + 1;
    const definition = await service.definition(current, positionAt(source, tableOffset));
    strict.strictEqual(Array.isArray(definition), false);
    strict.strictEqual((definition as { readonly uri?: string } | undefined)?.uri, pathToFileURL(schemaFile).href);
  });

  await it("returns preferred safe spelling fixes from resolver suggestions", async () => {
    const text = source.replace("user.name", "user.nam");
    const current = document("fix.ts", text);
    const diagnostics = await service.diagnostics(current);
    const unknown = diagnostics.find((diagnostic) => diagnostic.code === "TSQ101");
    strict.ok(unknown !== undefined);
    const actions = await service.codeActions(current, [unknown!]);
    strict.strictEqual(actions[0]?.title, "Replace with name");
    strict.strictEqual(actions[0]?.isPreferred, true);
  });

  await it("marks bare structural templates as trusted fragments without promoting their values", async () => {
    const text = [
      'import { sql as querySql } from "@typed-sql/postgres";',
      'const hostile = "\' OR TRUE --";',
      "interface Selection { readonly name: boolean }",
      "interface Filters { readonly name?: string | null }",
      "function users(select: Selection, filters: Filters) {",
      "  return querySql`SELECT user.id",
      "    ${select.name ? `, user.name` : querySql.empty}",
      "    FROM users AS user WHERE user.name <> ${hostile}",
      "    ${filters.name == null ? querySql.empty : `AND user.name = ${filters.name}`}`;",
      "}",
    ].join("\n");
    const current = document("fragment-fix.ts", text);
    const diagnostics = (await service.diagnostics(current)).filter(({ code }) => code === "TSQ004");
    strict.strictEqual(diagnostics.length, 2);
    strict.deepStrictEqual(
      diagnostics.map(({ range }) => current.getText(range)),
      ["`, user.name`", "`AND user.name = ${filters.name}`"],
    );

    const edits = [];
    for (const diagnostic of diagnostics) {
      const actions = await service.codeActions(current, [diagnostic]);
      strict.strictEqual(actions[0]?.title, "Mark as querySql.fragment");
      strict.strictEqual(actions[0]?.isPreferred, true);
      edits.push(...(actions[0]?.edit?.changes?.[current.uri] ?? []));
    }
    let fixed = text;
    for (const edit of edits.sort(
      (left, right) => current.offsetAt(right.range.start) - current.offsetAt(left.range.start),
    )) {
      const start = current.offsetAt(edit.range.start);
      const end = current.offsetAt(edit.range.end);
      fixed = `${fixed.slice(0, start)}${edit.newText}${fixed.slice(end)}`;
    }
    const updated = document("fragment-fix.ts", fixed, 2);
    strict.deepStrictEqual(await service.diagnostics(updated), []);
    const analysis = await service.analysis(updated);
    strict.ok(analysis?.transformedSource.includes("querySql.fragment<readonly [string]>") === true);
    strict.ok(fixed.includes("user.name <> ${hostile}"));

    const malformed = {
      ...diagnostics[0]!,
      data: { fix: { title: "Unsafe edit", range: { start: -1, end: text.length + 1 }, newText: "sql.raw" } },
    };
    strict.deepStrictEqual(await service.codeActions(current, [malformed]), []);
  });

  await it("bounds caches and honors cancellation", async () => {
    await service.analysis(document("cache-a.ts"));
    await service.analysis(document("cache-b.ts"));
    await service.analysis(document("cache-c.ts"));
    strict.ok(service.cacheSizes().analyses <= 2);
    await strict.rejects(
      () => service.analysis(document("cancelled.ts"), { isCancellationRequested: true }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    strict.throws(() => service.configure(workspaceDirectory, { maxCacheEntries: 0 }), /positive safe integer/);
  });

  await it("claims only typed-sql config and schema watcher events", async () => {
    strict.strictEqual(await service.handlesWatchedFile(pathToFileURL(configFile).href), true);
    strict.strictEqual(await service.handlesWatchedFile(pathToFileURL(schemaFile).href), true);
    strict.strictEqual(await service.handlesWatchedFile(pathToFileURL(projectFile).href), false);
    strict.strictEqual(await service.handlesWatchedFile("untitled:query.ts"), false);
  });

  await service.close();
});
