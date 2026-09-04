import type { PlaygroundDiagnostic, PlaygroundQuery } from "./playground.js";

interface EditorDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly source?: string;
}

interface EditorHover {
  readonly from: number;
  readonly to: number;
  readonly content: string;
}

function sourceOffset(source: string, line: number, column: number): number {
  const lines = source.split("\n");
  let offset = 0;
  for (let index = 0; index < line - 1; index += 1) offset += (lines[index]?.length ?? 0) + 1;
  return offset + Math.max(0, column - 1);
}

export function editorDiagnostics(
  source: string,
  diagnostics: readonly PlaygroundDiagnostic[],
): readonly EditorDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const from = sourceOffset(source, diagnostic.line, diagnostic.column);
    const to = sourceOffset(source, diagnostic.endLine ?? diagnostic.line, diagnostic.endColumn ?? diagnostic.column);
    return {
      from,
      to: Math.max(from + 1, to),
      severity: diagnostic.severity,
      message: diagnostic.suggestion ? `${diagnostic.message}\n${diagnostic.suggestion}` : diagnostic.message,
      source: diagnostic.code,
    };
  });
}

export function queryHovers(source: string, queries: readonly PlaygroundQuery[]): readonly EditorHover[] {
  return queries.flatMap((query) => {
    const from = source.indexOf(query.binding);
    return from < 0 ? [] : [{ from, to: from + query.binding.length, content: query.contract }];
  });
}
