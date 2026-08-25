import { type DialectPlugin, parameterTypeLiteral, rowTypeLiteral, type SchemaSnapshot } from "@typed-sql/core";
import { strict } from "poku";
import type { DialectSoundnessCase, SoundnessDialect, SoundnessExpectation } from "./corpus.js";

function diagnosticCodes(expectation: SoundnessExpectation): readonly string[] {
  if (expectation.kind === "diagnostic") return expectation.codes;
  return expectation.kind === "unknown" ? (expectation.diagnosticCodes ?? []) : [];
}

export function assertSoundnessCase<Snapshot extends SchemaSnapshot, Policy>(
  dialectName: SoundnessDialect,
  testCase: DialectSoundnessCase,
  dialect: DialectPlugin<Snapshot, Policy>,
  schema: Snapshot,
): void {
  const sql = testCase.sql((index) => dialect.placeholder(index));
  const analysis = dialect.analyze(sql, schema);
  const actualCodes = analysis.diagnostics.map(({ code }) => code);
  const errors = analysis.diagnostics.filter(({ severity }) => severity === "error");
  const rowType = analysis.resultKind === "command" ? "never" : rowTypeLiteral(analysis.columns);
  const parameterType = parameterTypeLiteral(testCase.parameterCount ?? 0, analysis.parameters);

  strict.ok(!rowType.includes("any"), `${dialectName}/${sql} inferred an unsafe row: ${rowType}`);
  strict.ok(!parameterType.includes("any"), `${dialectName}/${sql} inferred unsafe parameters: ${parameterType}`);
  for (const diagnostic of analysis.diagnostics) {
    strict.ok(diagnostic.range.start >= 0, `${dialectName}/${sql} produced a negative diagnostic start`);
    strict.ok(diagnostic.range.end >= diagnostic.range.start, `${dialectName}/${sql} produced an inverted range`);
    strict.ok(diagnostic.range.end <= sql.length, `${dialectName}/${sql} produced an out-of-bounds diagnostic`);
  }

  const expectation = testCase.expectation;
  if (expectation.kind === "exact") {
    strict.deepStrictEqual(errors, [], `${dialectName}/${sql} unexpectedly failed`);
    strict.strictEqual(rowType, expectation.rowType, `${dialectName}/${sql} row type changed`);
    strict.strictEqual(parameterType, expectation.parameterType, `${dialectName}/${sql} parameters changed`);
    strict.strictEqual(analysis.resultKind ?? "rows", expectation.resultKind ?? "rows");
    return;
  }

  for (const code of diagnosticCodes(expectation)) {
    strict.ok(actualCodes.includes(code), `${dialectName}/${sql} did not produce ${code}: ${actualCodes.join(", ")}`);
  }
  if (expectation.kind === "diagnostic") {
    strict.ok(errors.length > 0, `${dialectName}/${sql} must fail closed with an error`);
    return;
  }

  const inferred = expectation.target === "row" ? rowType : parameterType;
  strict.ok(inferred.includes("unknown"), `${dialectName}/${sql} must remain conservative: ${inferred}`);
}
