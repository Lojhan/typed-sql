import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "poku";
import { assertSoundnessCase } from "../../../test/soundness/assert-corpus.js";
import { soundnessCorpus } from "../../../test/soundness/corpus.js";
import { mysql } from "../src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dialect = mysql();
const schema = dialect.validateSnapshot(
  JSON.parse(await readFile(resolve(workspace, "e2e/mysql/generated/db/schema.json"), "utf8")) as unknown,
);

await describe("MySQL fail-closed soundness corpus", async () => {
  for (const testCase of soundnessCorpus) {
    await it(`${testCase.family}: ${testCase.id}`, () => {
      assertSoundnessCase("mysql", testCase.mysql, dialect, schema);
    });
  }
});
