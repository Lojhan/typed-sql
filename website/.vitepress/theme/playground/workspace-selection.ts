import type { WorkspaceProblem } from "./semantic-service.js";

export interface QuerySelection {
  readonly file: string;
  readonly binding: string;
}

export function querySelection(query: QuerySelection): QuerySelection {
  return { file: query.file, binding: query.binding };
}

export function queryAtPosition<Query extends QuerySelection & { sourceStart: number; sourceEnd: number }>(
  queries: readonly Query[],
  file: string,
  position: number,
): Query | undefined {
  return queries.find((query) => query.file === file && position >= query.sourceStart && position <= query.sourceEnd);
}

/** Keep the inspector attached to the selected source query rather than its array position. */
export function resolveQuerySelection<Query extends QuerySelection>(
  queries: readonly Query[],
  activeFile: string,
  selection?: QuerySelection,
): Query | undefined {
  const candidates = queries.filter(({ file }) => file === activeFile);
  if (selection?.file !== activeFile) return candidates[0];
  const matches = candidates.filter(({ binding }) => binding === selection.binding);
  return matches.length === 1 ? matches[0] : undefined;
}

export interface ProblemsPanelState {
  readonly open: boolean;
  readonly finalizedProblems: readonly WorkspaceProblem[];
}

function errorIdentity(problem: WorkspaceProblem): string {
  // Moving a diagnostic after editing preceding lines does not make it a new error.
  return JSON.stringify([problem.file, problem.code, problem.message]);
}

/** Pending analysis cannot erase diagnostics or override a user's collapsed panel. */
export function transitionProblemsPanel(
  previous: ProblemsPanelState,
  nextProblems: readonly WorkspaceProblem[],
  pending: boolean,
): ProblemsPanelState {
  if (pending) return previous;
  const existing = new Map<string, number>();
  for (const problem of previous.finalizedProblems) {
    if (problem.severity !== "error") continue;
    const identity = errorIdentity(problem);
    existing.set(identity, (existing.get(identity) ?? 0) + 1);
  }
  let hasNewError = false;
  for (const problem of nextProblems) {
    if (problem.severity !== "error") continue;
    const identity = errorIdentity(problem);
    const count = existing.get(identity) ?? 0;
    if (count === 0) hasNewError = true;
    else existing.set(identity, count - 1);
  }
  return { open: previous.open || hasNewError, finalizedProblems: nextProblems };
}
