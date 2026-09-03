import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { CONFIG_CACHE_LIMIT, discoverConfig, fromConfig, loadConfig } from "../src/index.js";

const fixture = new URL("../../../e2e/postgres/typed-sql.config.ts", import.meta.url);

await describe("typed-sql config", async () => {
  await it("loads a TypeScript config and preserves its installed dialect", async () => {
    const loaded = await loadConfig({ file: fixture.pathname });
    strict.strictEqual(loaded.config.dialect.id, "postgres");
    strict.strictEqual(
      fromConfig(loaded.directory, loaded.config.schema.file),
      join(loaded.directory, "generated/db/schema.json"),
    );
  });

  await it("reports discovery failure from nested directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-config-"));
    const nested = join(directory, "a", "b");
    await mkdir(nested, { recursive: true });
    await strict.rejects(() => discoverConfig(nested), /Could not find typed-sql\.config\.ts/);
    await rm(directory, { recursive: true, force: true });
  });

  await it("discovers a JavaScript config and resolves relative explicit paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-config-valid-"));
    const nested = join(directory, "src", "feature");
    await mkdir(nested, { recursive: true });
    const source = `
      export default {
        dialect: {
          contractVersion: 4,
          id: "fixture",
          grammarVersion: "1.0.0",
          sqlModule: "@example/typed-sql-fixture",
          capabilities: { returning: false },
          defaultTypePolicy: {},
          placeholder(index) { return "?" + index; },
          quoteIdentifier(identifier) { return "[" + identifier + "]"; },
          analyze() { return { columns: [], parameters: [], diagnostics: [] }; },
          validateSnapshot(value) { return value; }
        },
        schema: { file: "schema.json" },
        outDir: "generated"
      };
    `;
    await writeFile(join(directory, "typed-sql.config.mjs"), source);
    try {
      strict.strictEqual(await discoverConfig(nested), join(directory, "typed-sql.config.mjs"));
      strict.strictEqual((await loadConfig({ cwd: nested })).config.dialect.id, "fixture");
      strict.strictEqual((await loadConfig({ cwd: directory, file: "typed-sql.config.mjs" })).directory, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("reuses unchanged modules, reloads changed content, and bounds the cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-config-cache-"));
    const file = join(directory, "typed-sql.config.mjs");
    const source = (id: string) => `
      export default {
        dialect: {
          contractVersion: 4,
          id: ${JSON.stringify(id)},
          grammarVersion: "1.0.0",
          sqlModule: "@example/typed-sql-fixture",
          capabilities: {},
          defaultTypePolicy: {},
          placeholder(index) { return "?" + index; },
          quoteIdentifier(identifier) { return "[" + identifier + "]"; },
          analyze() { return { columns: [], parameters: [], diagnostics: [] }; },
          validateSnapshot(value) { return value; }
        },
        schema: { file: "schema.json" },
        outDir: "generated"
      };
    `;
    try {
      await writeFile(file, source("first"));
      const first = await loadConfig({ file });
      strict.strictEqual(await loadConfig({ file }), first);
      await writeFile(file, source("second"));
      const second = await loadConfig({ file });
      strict.notStrictEqual(second, first);
      strict.strictEqual(second.config.dialect.id, "second");
      for (let index = 0; index <= CONFIG_CACHE_LIMIT; index += 1) {
        await writeFile(file, source(`bounded-${index}`));
        strict.strictEqual((await loadConfig({ file })).config.dialect.id, `bounded-${index}`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("rejects malformed default exports at every contract boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-config-invalid-"));
    const candidates = [
      "null",
      "{}",
      "{ dialect: null }",
      "{ dialect: { contractVersion: 1 } }",
      "{ dialect: { contractVersion: 4, id: 1 } }",
      "{ dialect: { contractVersion: 4, id: 'x' } }",
      "{ dialect: { contractVersion: 4, id: 'x', analyze() {} } }",
      "{ dialect: { contractVersion: 4, id: 'x', analyze() {}, validateSnapshot() {} }, schema: {} }",
      "{ dialect: { contractVersion: 4, id: 'x', analyze() {}, validateSnapshot() {} }, schema: { file: 'x' } }",
      "{ dialect: { contractVersion: 1 }, schema: { file: 'x' }, outDir: 'generated' }",
    ];
    try {
      for (const [index, candidate] of candidates.entries()) {
        const file = join(directory, `invalid-${index}.mjs`);
        await writeFile(file, `export default ${candidate};`);
        await strict.rejects(() => loadConfig({ file }), /must default-export defineConfig/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
