import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "poku";
import { assertSoundnessCase } from "../../../test/soundness/assert-corpus.js";
import { soundnessCorpus } from "../../../test/soundness/corpus.js";
import { type PostgresSchemaSnapshot, postgres } from "../src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const schema = JSON.parse(
  await readFile(resolve(workspace, "e2e/postgres/generated/db/schema.json"), "utf8"),
) as PostgresSchemaSnapshot;
const dialect = postgres();

await describe("PostgreSQL fail-closed soundness corpus", async () => {
  for (const testCase of soundnessCorpus) {
    await it(`${testCase.family}: ${testCase.id}`, () => {
      assertSoundnessCase("postgres", testCase.postgres, dialect, schema);
    });
  }
});
