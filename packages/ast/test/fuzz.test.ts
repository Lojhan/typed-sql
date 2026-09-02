import { describe, it, strict } from "poku";
import { deterministicStrings, FUZZ_SEEDS, sqlFuzzRegressions } from "../../../test/fuzz/corpus.js";
import { parseStatement, SqlParseError } from "../src/index.js";

function outcome(source: string): unknown {
  try {
    const statement = parseStatement(source, { maxDepth: 32, maxTokens: 2_000, maxSqlLength: 10_000 });
    return { kind: statement.kind, range: statement.range };
  } catch (error) {
    if (!(error instanceof SqlParseError)) {
      throw error;
    }
    strict.ok(Number.isSafeInteger(error.range.start));
    strict.ok(Number.isSafeInteger(error.range.end));
    strict.ok(error.range.start >= 0 && error.range.end >= error.range.start && error.range.end <= source.length);
    strict.ok(error.range.line >= 1 && error.range.column >= 1);
    return { code: error.code, message: error.message, range: error.range };
  }
}

await describe("deterministic SQL parser fuzzing", async () => {
  await it("never crashes and returns stable diagnostics for seeded arbitrary inputs", () => {
    for (const source of [
      ...sqlFuzzRegressions.map((fixture) => fixture.source),
      ...deterministicStrings(FUZZ_SEEDS.sql, 2_000),
    ]) {
      strict.deepStrictEqual(outcome(source), outcome(source));
    }
  });
});
