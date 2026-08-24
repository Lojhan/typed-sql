import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { discoverConfig, fromConfig, loadConfig } from "../src/index.js";

const fixture = new URL("../../../e2e/postgres/typed-sql.config.ts", import.meta.url);

await describe("typed-sql config", async () => {
  await it("loads a TypeScript config and preserves its installed dialect", async () => {
    const loaded = await loadConfig({ file: fixture.pathname });
    strict.strictEqual(loaded.config.dialect.id, "postgres");
    strict.strictEqual(fromConfig(loaded.directory, loaded.config.schema.file), join(loaded.directory, "generated/db/schema.json"));
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
          contractVersion: 1,
          id: "fixture",
          packageVersion: "1.0.0",
          sqlModule: "@example/typed-sql-fixture",
          defaultTypePolicy: {},
          placeholder(index) { return "?" + index; },
          analyze() { return { columns: [], diagnostics: [] }; },
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
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  await it("rejects malformed default exports at every contract boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-config-invalid-"));
    const candidates = [
      "null",
      "{}",
      "{ dialect: null }",
      "{ dialect: { contractVersion: 2 } }",
      "{ dialect: { contractVersion: 1, id: 1 } }",
      "{ dialect: { contractVersion: 1, id: 'x' } }",
      "{ dialect: { contractVersion: 1, id: 'x', analyze() {} } }",
      "{ dialect: { contractVersion: 1, id: 'x', analyze() {}, validateSnapshot() {} }, schema: {} }",
      "{ dialect: { contractVersion: 1, id: 'x', analyze() {}, validateSnapshot() {} }, schema: { file: 'x' } }",
    ];
    try {
      for (const [index, candidate] of candidates.entries()) {
        const file = join(directory, `invalid-${index}.mjs`);
        await writeFile(file, `export default ${candidate};`);
        await strict.rejects(() => loadConfig({ file }), /must default-export defineConfig/);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
