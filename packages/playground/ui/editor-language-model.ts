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

export interface DocumentDiagnostic {
  code?: string | number;
  message: string;
  severity?: string | number;
  origin?: string;
  source?: string;
  engine?: string;
  sourceRevision?: string;
  from?: number;
  to?: number;
  range?: { line?: number; column?: number; start?: number; end?: number };
}
function diagnosticProducer(diagnostic: DocumentDiagnostic): string {
  if (diagnostic.origin === "database") return `database:${diagnostic.engine ?? ""}:${diagnostic.source ?? ""}`;
  const transport = !diagnostic.origin || ["analysis", "language-server", "typed-sql"].includes(diagnostic.origin);
  if (transport) {
    const source = diagnostic.source;
    if (!source || source === "typed-sql" || source === `typed-sql ${diagnostic.code}`) return "typed-sql";
    if (source === "ts" || source === "typescript") return "typescript";
  }
  return `${diagnostic.origin ?? ""}:${diagnostic.source ?? ""}`;
}
function diagnosticStart(diagnostic: DocumentDiagnostic): string | undefined {
  if (Number.isInteger(diagnostic.range?.line) && Number.isInteger(diagnostic.range?.column))
    return `line:${diagnostic.range!.line}:${diagnostic.range!.column}`;
  const start = diagnostic.from ?? diagnostic.range?.start;
  return Number.isInteger(start) && start! >= 0 ? `offset:${start}` : undefined;
}
function diagnosticWidth(diagnostic: DocumentDiagnostic): number {
  const start = diagnostic.from ?? diagnostic.range?.start;
  const end = diagnostic.to ?? diagnostic.range?.end;
  return typeof start === "number" && typeof end === "number" ? Math.max(0, end - start) : 0;
}
/** Merge transports for one document; retain distinct producers, codes, severities and occurrences. */
export function mergeDocumentDiagnostics<T extends DocumentDiagnostic>(diagnostics: readonly T[]): T[] {
  const result: T[] = [];
  const seen = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const code = diagnostic.code === undefined ? "" : String(diagnostic.code);
    let message = diagnostic.message;
    const prefix = `${code}:`;
    if (code && message.startsWith(prefix)) message = message.slice(prefix.length).trimStart();
    const value = message === diagnostic.message ? diagnostic : { ...diagnostic, message };
    const start = diagnosticStart(diagnostic);
    // Unlocated or unclassified findings cannot be proven to be the same occurrence.
    if (!start || !code) {
      result.push(value);
      continue;
    }
    const producer = diagnosticProducer(diagnostic);
    const key = JSON.stringify([
      producer,
      code,
      diagnostic.severity,
      start,
      message,
      producer === "typed-sql" || producer === "typescript" ? "" : (diagnostic.sourceRevision ?? ""),
    ]);
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, result.length);
      result.push(value);
    } else if (diagnosticWidth(value) > diagnosticWidth(result[previous]!)) {
      // A language-server span can enrich a host's point diagnostic without adding a second finding.
      result[previous] = { ...result[previous]!, ...value };
    }
  }
  return result;
}
