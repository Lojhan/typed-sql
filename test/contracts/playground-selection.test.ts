import { describe, it, strict } from "poku";
import type { WorkspaceProblem } from "../../website/.vitepress/theme/playground/semantic-service.js";
import {
  type ProblemsPanelState,
  querySelection,
  resolveQuerySelection,
  transitionProblemsPanel,
} from "../../website/.vitepress/theme/playground/workspace-selection.js";

function problem(overrides: Partial<WorkspaceProblem> = {}): WorkspaceProblem {
  return {
    file: "queries/account.sql",
    from: 7,
    to: 14,
    line: 1,
    code: "TSQ101",
    message: "Unknown column missing.",
    severity: "error",
    ...overrides,
  };
}

await describe("playground source selection", async () => {
  const first = { file: "queries/account.sql", binding: "first", sourceStart: 0 };
  const second = { file: "queries/account.sql", binding: "second", sourceStart: 50 };
  const other = { file: "queries/other.ts", binding: "first", sourceStart: 0 };

  await it("selects only queries owned by the active source file", () => {
    strict.strictEqual(resolveQuerySelection([other, first, second], first.file), first);
    for (const file of ["app.ts", "schema.sql", "empty.ts", "queries/invalid.sql"])
      strict.strictEqual(resolveQuerySelection([other, first, second], file), undefined);
    strict.strictEqual(resolveQuerySelection([], first.file), undefined);
  });

  await it("keeps a selected binding when preceding queries are inserted, removed, or moved", () => {
    const selected = querySelection(second);
    const inserted = { file: first.file, binding: "inserted", sourceStart: 0 };
    const shifted = { ...second, sourceStart: 120 };
    strict.strictEqual(resolveQuerySelection([inserted, first, other, shifted], second.file, selected), shifted);
    strict.strictEqual(resolveQuerySelection([shifted, other], second.file, selected), shifted);
    strict.strictEqual(resolveQuerySelection([other, shifted, first], second.file, selected), shifted);
  });

  await it("clears an invalidated or removed query without substituting another exact contract", () => {
    const selected = querySelection(second);
    strict.strictEqual(resolveQuerySelection([first, other], second.file, selected), undefined);
    strict.strictEqual(resolveQuerySelection([other], second.file, selected), undefined);
    strict.strictEqual(resolveQuerySelection([first, other], "app.ts", selected), undefined);
  });

  await it("changes file scope explicitly and rejects ambiguous duplicate identities", () => {
    strict.strictEqual(resolveQuerySelection([first, other], other.file, querySelection(first)), other);
    strict.strictEqual(
      resolveQuerySelection([second, { ...second, sourceStart: 100 }], second.file, querySelection(second)),
      undefined,
    );
  });
});

await describe("playground finalized diagnostics", async () => {
  const error = problem();

  await it("retains finalized errors and a collapsed panel while analysis is pending", () => {
    const previous: ProblemsPanelState = { open: false, finalizedProblems: [error] };
    strict.strictEqual(transitionProblemsPanel(previous, [], true), previous);
    const pending = transitionProblemsPanel(previous, [problem({ code: "TSQ102" })], true);
    strict.strictEqual(pending, previous);
    const finalized = transitionProblemsPanel(pending, [{ ...error }], false);
    strict.strictEqual(finalized.open, false);
    strict.deepStrictEqual(finalized.finalizedProblems, [error]);
  });

  await it("does not reopen for moved or reordered existing errors", () => {
    const second = problem({ message: "Unknown column another.", from: 30, to: 37 });
    const previous: ProblemsPanelState = { open: false, finalizedProblems: [error, second] };
    const moved = { ...error, from: 57, to: 64, line: 4 };
    strict.strictEqual(transitionProblemsPanel(previous, [second, moved], false).open, false);
  });

  await it("opens for a genuinely new error and for an additional occurrence of the same error", () => {
    const previous: ProblemsPanelState = { open: false, finalizedProblems: [error] };
    const changed = problem({ message: "Unknown table missing." });
    strict.strictEqual(transitionProblemsPanel(previous, [changed], false).open, true);
    strict.strictEqual(transitionProblemsPanel(previous, [error, { ...error, from: 30, to: 37 }], false).open, true);
    strict.strictEqual(transitionProblemsPanel({ open: false, finalizedProblems: [] }, [error], false).open, true);
  });

  await it("does not open for warnings or error removal and keeps an already open panel open", () => {
    const previous: ProblemsPanelState = { open: false, finalizedProblems: [error] };
    strict.strictEqual(transitionProblemsPanel(previous, [], false).open, false);
    strict.strictEqual(transitionProblemsPanel(previous, [problem({ severity: "warning" })], false).open, false);
    strict.strictEqual(transitionProblemsPanel({ open: true, finalizedProblems: [error] }, [error], false).open, true);
  });
});
