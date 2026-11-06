/** Browser-side LSP positions use UTF-16, matching CodeMirror and JavaScript strings. */
export interface LanguagePosition {
  line: number;
  character: number;
}
export interface LanguageRange {
  start: LanguagePosition;
  end: LanguagePosition;
}
export interface LanguageEdit {
  range: LanguageRange;
  newText: string;
}
export interface LanguageDiagnostic {
  range: LanguageRange;
  message: string;
  severity?: number;
  code?: string | number;
  source?: string;
  tags?: number[];
}
export interface LanguageLocation {
  file?: string;
  uri?: string;
  token?: string;
  readOnly?: boolean;
  range: LanguageRange;
}
export interface LanguageCompletion {
  label: string;
  detail?: string;
  documentation?: unknown;
  kind?: number;
  insertText?: string;
  insertTextFormat?: number;
  sortText?: string;
  filterText?: string;
  textEdit?: LanguageEdit | { insert: LanguageRange; replace: LanguageRange; newText: string };
  additionalTextEdits?: LanguageEdit[];
  data?: unknown;
}
export function positionAt(source: string, offset: number): LanguagePosition {
  const until = Number.isFinite(offset) ? Math.max(0, Math.min(source.length, Math.trunc(offset))) : 0;
  let line = 0;
  let start = 0;
  for (let index = 0; index < until; index++)
    if (source.charCodeAt(index) === 10) {
      line++;
      start = index + 1;
    }
  return { line, character: until - start };
}
export function offsetAt(source: string, position: LanguagePosition): number | undefined {
  if (
    !Number.isInteger(position?.line) ||
    !Number.isInteger(position?.character) ||
    position.line < 0 ||
    position.character < 0
  )
    return undefined;
  let start = 0;
  for (let line = 0; line < position.line; line++) {
    const newline = source.indexOf("\n", start);
    if (newline < 0) return undefined;
    start = newline + 1;
  }
  const newline = source.indexOf("\n", start);
  let end = newline < 0 ? source.length : newline;
  if (end > start && source.charCodeAt(end - 1) === 13) end--;
  return Math.min(start + position.character, end);
}
export function offsets(source: string, range: LanguageRange): { from: number; to: number } | undefined {
  if (!range || typeof range !== "object") return undefined;
  const from = offsetAt(source, range.start);
  const to = offsetAt(source, range.end);
  return from === undefined || to === undefined || to < from ? undefined : { from, to };
}
/** All edits refer to the same source. Reject overlapping or malformed changes rather than guessing. */
export function textChanges(
  source: string,
  edits: readonly LanguageEdit[],
): { from: number; to: number; insert: string }[] | undefined {
  const result: { from: number; to: number; insert: string }[] = [];
  for (const edit of edits) {
    if (!edit || typeof edit.newText !== "string") return undefined;
    const range = offsets(source, edit.range);
    if (!range) return undefined;
    result.push({ ...range, insert: edit.newText });
  }
  result.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let index = 1; index < result.length; index++) {
    const previous = result[index - 1]!;
    const current = result[index]!;
    if (current.from < previous.to || (current.from === previous.from && current.to === previous.to)) return undefined;
  }
  return result;
}
export function displayDocumentation(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(displayDocumentation).filter(Boolean).join("\n\n");
  if (value && typeof value === "object" && "value" in value && typeof value.value === "string") {
    if ("language" in value && typeof value.language === "string")
      return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
    return value.value;
  }
  return "";
}
export function completionItems(result: unknown): LanguageCompletion[] {
  const items = Array.isArray(result)
    ? result
    : result && typeof result === "object" && "items" in result && Array.isArray(result.items)
      ? result.items
      : [];
  const defaults =
    !Array.isArray(result) && result && typeof result === "object" && "itemDefaults" in result
      ? (result.itemDefaults as {
          editRange?: LanguageRange | { insert: LanguageRange; replace: LanguageRange };
          insertTextFormat?: number;
        })
      : undefined;
  return items
    .filter((item): item is LanguageCompletion =>
      Boolean(item && typeof item === "object" && typeof item.label === "string"),
    )
    .map((item) => {
      if (item.textEdit || !defaults?.editRange)
        return {
          ...item,
          ...(item.insertTextFormat === undefined && defaults?.insertTextFormat !== undefined
            ? { insertTextFormat: defaults.insertTextFormat }
            : {}),
        };
      const range = defaults.editRange;
      return {
        ...item,
        insertTextFormat: item.insertTextFormat ?? defaults.insertTextFormat ?? 1,
        textEdit: { ...("start" in range ? { range } : range), newText: item.insertText ?? item.label },
      };
    });
}

export interface WorkingCopy {
  file: string;
  source: string;
  revision: string;
}
/** Canonical ordering/key order shared with the host context identity. Current source is sent separately. */
export function canonicalWorkingCopies(copies: readonly WorkingCopy[], currentFile: string): WorkingCopy[] {
  return copies
    .filter((copy) => copy.file !== currentFile)
    .map(({ file, source, revision }) => ({ file, source, revision }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
