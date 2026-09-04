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
  const hovers: EditorHover[] = [];
  const resultBindings: { readonly name: string; readonly rowType: string; readonly type: string }[] = [];
  const calls =
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+[A-Za-z_$][\w$.]*\.(execute|all|one|maybeOne)\s*\(/gu;

  for (const match of source.matchAll(calls)) {
    const name = match[1]!;
    const method = match[2]!;
    const callStart = (match.index ?? 0) + match[0].length;
    const callEnd = source.indexOf(";", callStart);
    const argument = source.slice(callStart, callEnd < 0 ? source.length : callEnd);
    const query = queries.find(
      (candidate) =>
        (candidate.sourceStart >= callStart && (callEnd < 0 || candidate.sourceStart < callEnd)) ||
        new RegExp(`\\b${candidate.binding.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(argument),
    );
    if (query === undefined) continue;
    const type =
      method === "one"
        ? query.rowType
        : method === "maybeOne"
          ? `${query.rowType} | undefined`
          : `readonly ${query.rowType}[]`;
    resultBindings.push({ name, rowType: query.rowType, type });
  }

  for (const result of resultBindings) {
    const escaped = result.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    for (const match of source.matchAll(new RegExp(`\\b${escaped}\\s*\\[\\s*\\d+\\s*\\]`, "gu"))) {
      const expression = match[0];
      hovers.push({
        from: match.index ?? 0,
        to: (match.index ?? 0) + expression.length,
        content: `(element) ${expression}: ${result.rowType}`,
      });
    }
    for (const match of source.matchAll(new RegExp(`\\b${escaped}\\b`, "gu"))) {
      hovers.push({
        from: match.index ?? 0,
        to: (match.index ?? 0) + result.name.length,
        content: `const ${result.name}: ${result.type}`,
      });
    }
  }

  for (const query of queries) {
    const escaped = query.binding.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    for (const match of source.matchAll(new RegExp(`\\b${escaped}\\b`, "gu"))) {
      hovers.push({ from: match.index ?? 0, to: (match.index ?? 0) + query.binding.length, content: query.contract });
    }
  }
  return hovers;
}
