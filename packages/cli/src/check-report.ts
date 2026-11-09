import { relative } from "node:path";
import type { SourceAnalysisResult } from "@typed-sql/compiler";
export function reportCheckedFiles(input: {
  readonly files: readonly { readonly file: string; readonly analysis: SourceAnalysisResult }[];
  readonly output: string;
  readonly ok: boolean;
  readonly directory: string;
  readonly showTypes: boolean;
}): void {
  let sqlErrors = false;
  for (const { file, analysis } of input.files) {
    for (const diagnostic of analysis.diagnostics) {
      sqlErrors ||= diagnostic.severity === "error";
      const suggestion = diagnostic.suggestion === undefined ? "" : ` ${diagnostic.suggestion}`;
      process.stderr.write(
        `${file}:${diagnostic.range.line}:${diagnostic.range.column} - ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${suggestion}\n`,
      );
    }
    if (input.showTypes)
      for (const query of analysis.queries)
        process.stdout.write(
          `${relative(input.directory, file)}: ${query.binding?.name ?? `query ${query.index + 1}`} — ${query.queryType}\n`,
        );
  }
  if (!sqlErrors && input.output) process.stderr.write(input.output);
  if (!input.ok) process.exitCode = 1;
}
