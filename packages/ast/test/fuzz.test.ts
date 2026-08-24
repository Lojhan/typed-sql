import { describe, it, strict } from "poku";
import { parseStatement, SqlParseError } from "../src/index.js";

function randomSources(seed: number, count: number): readonly string[] {
  let state = seed >>> 0;
  const alphabet = "SELECT FROM WHERE WITH INSERT UPDATE DELETE RETURNING abc_123$(),.*+-/'\\\"[]\n\t";
  const sources: string[] = [];
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const length = state % 160;
    let source = "";
    for (let offset = 0; offset < length; offset += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      source += alphabet[state % alphabet.length];
    }
    sources.push(source);
  }
  return sources;
}

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
    for (const source of randomSources(0x51_7a_2026, 2_000)) {
      strict.deepStrictEqual(outcome(source), outcome(source));
    }
  });
});
