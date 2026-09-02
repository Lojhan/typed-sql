import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { TypeScriptBridge } from "../../ts-bridge/src/index.js";
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

    const dynamicSource = [
      'import { sql } from "@typed-sql/postgres";',
      'const users = "users";',
      "const query = sql`SELECT user.id FROM users AS user WHERE user.name = ${users}`;",
    ].join("\n");
    const dynamic = document("dynamic-navigation.ts", dynamicSource);
    const dynamicOffset = dynamicSource.lastIndexOf("users") + 1;
    strict.strictEqual(await service.definition(dynamic, positionAt(dynamicSource, dynamicOffset)), undefined);
    strict.deepStrictEqual(await service.completions(dynamic, positionAt(dynamicSource, dynamicOffset)), []);
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
    service.invalidate();
    strict.deepStrictEqual(await service.codeActions(current, [diagnostics[0]!]), []);
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
    const identified = await service.analysis(document("cache-a.ts", source, 7));
    strict.strictEqual(identified?.identity.source.id, document("cache-a.ts").uri);
    strict.strictEqual(identified?.identity.source.version, 7);
    strict.strictEqual(identified?.identity.grammar.id, "postgres");
    strict.strictEqual(identified?.identity.project?.id, projectFile);
    strict.match(identified?.identity.project?.configHash ?? "", /^sha256:[a-f\d]{64}$/u);
    strict.match(identified?.identity.schema.hash ?? "", /^[a-f\d]{64}$/u);
    strict.match(identified?.identity.grammar.capabilityFingerprint ?? "", /^sha256:[a-f\d]{64}$/u);
    strict.match(identified?.identity.typePolicyHash ?? "", /^[a-f\d]{64}$/u);
    strict.strictEqual(
      identified === undefined ? false : service.isAnalysisCurrent(document("cache-a.ts", source, 7), identified),
      true,
    );
    const generation = identified?.identity.project?.generation ?? -1;
    service.invalidate();
    strict.strictEqual(
      identified === undefined ? true : service.isAnalysisCurrent(document("cache-a.ts", source, 7), identified),
      false,
    );
    const refreshed = await service.analysis(document("cache-a.ts", source, 7));
    strict.ok((refreshed?.identity.project?.generation ?? -1) > generation);
    strict.notStrictEqual(refreshed?.revision, identified?.revision);
    await service.analysis(document("cache-a.ts", source, 7));
    await service.analysis(document("cache-b.ts"));
    await service.analysis(document("cache-c.ts"));
    strict.ok(service.cacheSizes().analyses <= 2);
    const metrics = service.metrics();
    strict.ok(metrics.cache.analyses.hits >= 1);
    strict.ok(metrics.cache.analyses.misses >= 3);
    strict.ok(metrics.cache.analyses.evictions >= 1);
    strict.strictEqual(metrics.cache.analyses.entries, service.cacheSizes().analyses);
    strict.ok(Object.isFrozen(metrics));
    strict.ok(Object.isFrozen(metrics.cache));
    await strict.rejects(
      () => service.analysis(document("cancelled.ts"), { isCancellationRequested: true }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    strict.throws(() => service.configure(workspaceDirectory, { maxCacheEntries: 0 }), /positive safe integer/);
    strict.throws(() => service.configure(workspaceDirectory, { analysisDebounceMs: -1 }), /non-negative safe integer/);
  });

  await it("claims only typed-sql config and schema watcher events", async () => {
    strict.strictEqual(await service.handlesWatchedFile(pathToFileURL(configFile).href), true);
    strict.strictEqual(await service.handlesWatchedFile(pathToFileURL(schemaFile).href), true);
    strict.strictEqual(await service.handlesWatchedFile(pathToFileURL(projectFile).href), false);
    strict.strictEqual(await service.handlesWatchedFile("untitled:query.ts"), false);
  });

  await service.close();
});

await describe("typed-sql capability evidence reload", async () => {
  await it("reanalyzes open SQL after watched server evidence changes", async () => {
    const temporary = await mkdtemp(join(workspaceDirectory, ".typed-sql-language-capabilities-"));
    const config = join(temporary, "typed-sql.config.ts");
    const schema = join(temporary, "schema.json");
    const snapshot = (version: string) => ({
      formatVersion: 1,
      dialect: "sqlite",
      version,
      server: { product: "sqlite", version, versionKey: version, features: [], settings: {} },
      tables: {
        account: {
          name: "account",
          strict: true,
          kind: "table",
          withoutRowid: false,
          indexes: [],
          foreignKeys: [],
          columns: { id: { name: "id", databaseType: "INTEGER", tsType: "bigint", nullable: false } },
        },
      },
    });
    try {
      await writeFile(
        config,
        [
          'import { defineConfig } from "../packages/core/src/index.ts";',
          'import { sqlite } from "../packages/sqlite/src/index.ts";',
          'export default defineConfig({ dialect: sqlite(), schema: { file: "schema.json" }, outDir: "generated" });',
        ].join("\n"),
      );
      await writeFile(schema, `${JSON.stringify(snapshot("3.34.1"))}\n`);
      const service = new TypedSqlLanguageService(temporary, {
        configPath: config,
        schemaPath: schema,
        nativePreview: false,
      });
      const text = 'import { sql } from "@typed-sql/sqlite"; sql`UPDATE account SET id = 1 RETURNING id`;';
      const current = TextDocument.create(pathToFileURL(join(temporary, "query.ts")).href, "typescript", 1, text);
      strict.ok((await service.diagnostics(current)).some(({ code }) => code === "TSQ404"));
      await writeFile(schema, `${JSON.stringify(snapshot("3.35.0"))}\n`);
      service.invalidate();
      strict.ok(!(await service.diagnostics(current)).some(({ code }) => code === "TSQ404"));
      await service.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

await describe("typed-sql native bridge recovery", async () => {
  await it("disposes a failed bridge and retries once with a clean instance", async () => {
    let created = 0;
    let closed = 0;
    const nativeBridge = (): TypeScriptBridge => {
      created += 1;
      const attempt = created;
      return {
        identity: {
          id: "test-preview",
          line: "7.1",
          version: "7.1.0-test",
          apiStability: "unstable",
        },
        async inspectFile() {
          if (attempt === 1) throw new Error("injected bridge failure");
          return [{ queryIndex: 0, typeText: "Query<Recovered, readonly []>" }];
        },
        async inspectFiles() {
          return new Map();
        },
        async close() {
          closed += 1;
        },
      };
    };
    const service = new TypedSqlLanguageService(
      workspaceDirectory,
      { configPath: configFile, schemaPath: schemaFile, projectFile, nativePreview: true },
      { nativeBridge },
    );
    try {
      const current = document("bridge-recovery.ts");
      const hover = await service.hover(current, current.positionAt(source.indexOf("query")));
      strict.ok(JSON.stringify(hover?.contents).includes("Query<Recovered"));
      strict.strictEqual(created, 2);
      strict.strictEqual(closed, 1);
      strict.strictEqual(service.metrics().bridgeRestarts, 1);
    } finally {
      await service.close();
    }
    strict.strictEqual(closed, 2);
  });
});
