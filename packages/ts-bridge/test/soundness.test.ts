import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { assertSourceCompilation } from "../../../test/soundness/assert-source-corpus.js";
import { sourceForDialect, sourceSoundnessCorpus } from "../../../test/soundness/source-corpus.js";
import { compileSource } from "../../compiler/src/index.js";
import { mysql } from "../../mysql/src/index.js";
import { postgres } from "../../postgres/src/index.js";
import { analyzeSource } from "../src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const postgresDialect = postgres();
const mysqlDialect = mysql();
const postgresSchema = postgresDialect.validateSnapshot(
  JSON.parse(await readFile(resolve(workspace, "e2e/postgres/generated/db/schema.json"), "utf8")) as unknown,
);
const mysqlSchema = mysqlDialect.validateSnapshot(
  JSON.parse(await readFile(resolve(workspace, "e2e/mysql/generated/db/schema.json"), "utf8")) as unknown,
);

function assertParity(
  sourceCase: (typeof sourceSoundnessCorpus)[number],
  compilation: ReturnType<typeof compileSource>,
  bridge: ReturnType<typeof analyzeSource>,
): void {
  assertSourceCompilation(sourceCase, compilation);
  strict.deepStrictEqual(bridge.diagnostics, compilation.diagnostics);
  strict.deepStrictEqual(
    bridge.queries.map(({ rowType, parameterType }) => ({ rowType, parameterType })),
    compilation.queries.map(({ rowType, parameterType }) => ({ rowType, parameterType })),
  );
  strict.strictEqual(bridge.transformedSource, compilation.transformedSource);
}

await describe("TypeScript bridge soundness parity", async () => {
  for (const testCase of sourceSoundnessCorpus) {
    await it(`postgres: ${testCase.id}`, () => {
      const sourceCase = { ...testCase, source: sourceForDialect(testCase, "postgres") };
      assertParity(
        sourceCase,
        compileSource({ source: sourceCase.source, schema: postgresSchema, dialect: postgresDialect }),
        analyzeSource(sourceCase.source, postgresSchema, postgresDialect),
      );
    });
    await it(`mysql: ${testCase.id}`, () => {
      const sourceCase = { ...testCase, source: sourceForDialect(testCase, "mysql") };
      assertParity(
        sourceCase,
        compileSource({ source: sourceCase.source, schema: mysqlSchema, dialect: mysqlDialect }),
        analyzeSource(sourceCase.source, mysqlSchema, mysqlDialect),
      );
    });
  }
});
