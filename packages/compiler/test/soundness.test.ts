import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "poku";
import { assertSourceCompilation } from "../../../test/soundness/assert-source-corpus.js";
import { sourceForDialect, sourceSoundnessCorpus } from "../../../test/soundness/source-corpus.js";
import { type MySqlSchemaSnapshot, mysql } from "../../mysql/src/index.js";
import { type PostgresSchemaSnapshot, postgres } from "../../postgres/src/index.js";
import { compileSource } from "../src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const postgresSchema = JSON.parse(
  await readFile(resolve(workspace, "e2e/postgres/generated/db/schema.json"), "utf8"),
) as PostgresSchemaSnapshot;
const mysqlSchema = JSON.parse(
  await readFile(resolve(workspace, "e2e/mysql/generated/db/schema.json"), "utf8"),
) as MySqlSchemaSnapshot;
const postgresDialect = postgres();
const mysqlDialect = mysql();

await describe("compiler fail-closed source corpus", async () => {
  for (const testCase of sourceSoundnessCorpus) {
    await it(`postgres: ${testCase.id}`, () => {
      const sourceCase = { ...testCase, source: sourceForDialect(testCase, "postgres") };
      assertSourceCompilation(
        sourceCase,
        compileSource({ source: sourceCase.source, schema: postgresSchema, dialect: postgresDialect }),
      );
    });
    await it(`mysql: ${testCase.id}`, () => {
      const sourceCase = { ...testCase, source: sourceForDialect(testCase, "mysql") };
      assertSourceCompilation(
        sourceCase,
        compileSource({ source: sourceCase.source, schema: mysqlSchema, dialect: mysqlDialect }),
      );
    });
  }
});
