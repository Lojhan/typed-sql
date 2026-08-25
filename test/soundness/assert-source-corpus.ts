import { strict } from "poku";
import type { CompileSourceResult } from "../../packages/compiler/src/index.js";
import type { SourceSoundnessCase } from "./source-corpus.js";

export function assertSourceCompilation(testCase: SourceSoundnessCase, compilation: CompileSourceResult): void {
  strict.ok(!compilation.transformedSource.includes(": any"), `${testCase.id} introduced any`);
  const expectation = testCase.expectation;
  if (expectation.kind === "dynamic") {
    strict.strictEqual(compilation.queries.length, 0);
    strict.strictEqual(compilation.fragments.length, 0);
    strict.deepStrictEqual(compilation.diagnostics, []);
    strict.strictEqual(compilation.transformedSource, testCase.source);
    return;
  }
  if (expectation.kind === "diagnostic") {
    const codes = compilation.diagnostics.map(({ code }) => code);
    for (const code of expectation.codes) strict.ok(codes.includes(code), `${testCase.id} did not produce ${code}`);
    strict.ok(compilation.diagnostics.some(({ severity }) => severity === "error"));
    strict.ok(
      compilation.diagnostics.some(({ range }) =>
        testCase.source.slice(range.start, range.end).includes(expectation.sourceTarget),
      ),
      `${testCase.id} did not map its diagnostic to ${expectation.sourceTarget}`,
    );
    strict.strictEqual(compilation.queries.length, 0, `${testCase.id} must not emit a confident query overlay`);
    return;
  }

  strict.deepStrictEqual(compilation.diagnostics, []);
  strict.strictEqual(compilation.queries.length, 1);
  const query = compilation.queries[0]!;
  if (expectation.kind === "exact") {
    strict.strictEqual(query.rowType, expectation.rowType);
    strict.strictEqual(query.parameterType, expectation.parameterType);
    return;
  }

  strict.strictEqual(query.structural, true);
  for (const value of expectation.rowIncludes) strict.ok(query.rowType.includes(value), query.rowType);
  const parameterTypes = compilation.fragments.map(({ parameterType }) => parameterType);
  for (const value of expectation.fragmentParameterTypes) {
    strict.ok(parameterTypes.includes(value), `${testCase.id} did not infer fragment ${value}`);
  }
}
