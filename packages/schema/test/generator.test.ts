import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  checkSchemaDrift,
  generateSchemaPackage,
  loadGeneratedSchemaSnapshot,
  type SchemaSnapshot,
} from "../src/index.js";

const schema = {
  dialect: "postgres",
  tables: {
    users: {
      name: "users",
      columns: {
        id: { name: "id", databaseType: "integer", tsType: "number", nullable: false },
      },
    },
  },
} as const satisfies SchemaSnapshot;

await describe("schema package generation", async () => {
  await it("emits TypeScript, JSON, and reproducible hashes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-generator-"));
    try {
      const first = await generateSchemaPackage(schema, { outDir: directory, generatorVersion: "test" });
      const second = await generateSchemaPackage(schema, { outDir: directory, generatorVersion: "test" });
      strict.deepStrictEqual(first, second);
      const moduleSource = await readFile(join(directory, "index.ts"), "utf8");
      const jsonSource = await readFile(join(directory, "schema.json"), "utf8");
      strict.ok(moduleSource.includes("export const schema"));
      strict.ok(moduleSource.includes(first.schemaHash));
      strict.ok(moduleSource.includes('export { sql } from "@typed-sql/core"'));
      strict.ok(!moduleSource.includes("createGeneratedDatabase"));
      strict.ok(jsonSource.includes(first.typePolicyHash));

      const generated = await loadGeneratedSchemaSnapshot(join(directory, "schema.json"));
      strict.strictEqual(checkSchemaDrift(generated, schema).drifted, false);
      const changed = { ...schema, version: "18" } satisfies SchemaSnapshot;
      const drift = checkSchemaDrift(generated, changed);
      strict.strictEqual(drift.drifted, true);
      strict.strictEqual(drift.schemaChanged, true);
      strict.strictEqual(drift.typePolicyChanged, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
