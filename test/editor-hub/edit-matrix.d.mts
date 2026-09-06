export const editCases: string[];
export interface SourceEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}
export function applySourceEdits(
  sources: Record<string, string>,
  edits: Record<string, SourceEdit[]>,
): Record<string, string>;
export function assertSqlPreserved(before: string, after: string, query: string): void;
