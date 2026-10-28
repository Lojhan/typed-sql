import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildQueryValuePlan,
  DEFAULT_MAX_GENERATED_DECLARATION_BYTES,
  DEFAULT_MAX_SOURCE_BYTES,
} from "@typed-sql/compiler";
import { type LoadedConfig, loadConfig } from "@typed-sql/config";
import { parameterTypeLiteral, rowTypeLiteral, type SchemaSnapshot, type SqlDiagnostic } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";

export interface SqlFileProject {
  readonly loaded: LoadedConfig;
  readonly snapshot: SchemaSnapshot;
  readonly watchedFiles: readonly string[];
  readonly configIdentity: string;
}

/** Reads only the configured offline snapshot; no provider or database is invoked. */
export async function loadSqlFileProject(cwd: string, config?: string): Promise<SqlFileProject> {
  const loaded = await loadConfig({ cwd, ...(config === undefined ? {} : { file: config }) });
  const schemaFile = resolve(loaded.directory, loaded.config.schema.file);
  const watchedFiles = [...new Set([...(loaded.dependencies ?? [loaded.file]), schemaFile])].sort();
  const contents = await Promise.all(watchedFiles.map((file) => readFile(file, "utf8")));
  const schemaText = contents[watchedFiles.indexOf(schemaFile)]!;
  const snapshot = loaded.config.dialect.validateSnapshot(JSON.parse(schemaText));
  const dialect = loaded.config.dialect;
  const hash = createHash("sha256")
    .update(dialect.id)
    .update("\0")
    .update(dialect.grammarVersion)
    .update("\0")
    .update(calculateTypePolicyHash(loaded.config.typePolicy ?? dialect.defaultTypePolicy))
    .update("\0");
  for (const [index, file] of watchedFiles.entries())
    hash.update(file).update("\0").update(contents[index]!).update("\0");
  return { loaded, snapshot, watchedFiles, configIdentity: hash.digest("hex") };
}

export interface SqlFileAnalysis {
  readonly text: string;
  readonly extension: ".ts";
  readonly diagnostics: readonly {
    readonly messageText: string;
    readonly code: number;
    readonly start: number;
    readonly length: number;
  }[];
  readonly runtime: string;
}

/** Uses the selected grammar for SQL semantics and placeholder lexing. */
export function analyzeSqlFile(content: string, project: SqlFileProject): SqlFileAnalysis {
  const { dialect, typePolicy } = project.loaded.config;
  const policy = typePolicy ?? dialect.defaultTypePolicy;
  const diagnostics: SqlDiagnostic[] = [];
  const unavailable = (message: string): SqlDiagnostic => ({
    code: "TSQ901",
    severity: "error",
    message,
    range: { start: 0, end: Math.min(content.length, 1), line: 1, column: 1 },
  });
  if (Buffer.byteLength(content) > DEFAULT_MAX_SOURCE_BYTES)
    diagnostics.push(unavailable("SQL file exceeds the source size limit."));
  if (dialect.runtimeSqlModule === undefined)
    diagnostics.push(unavailable("SQL files require a grammar portable runtime entrypoint."));
  const analysis =
    diagnostics.length === 0
      ? dialect.analyze(content, project.snapshot, policy, { runtimeValidation: true })
      : undefined;
  diagnostics.push(...(analysis?.diagnostics ?? []));
  const parts: string[] = [];
  let count = 0;
  if (!diagnostics.some((item) => item.severity === "error")) {
    if (dialect.parameterOccurrences === undefined)
      diagnostics.push(unavailable("This grammar does not support SQL-file parameter binding."));
    else {
      const occurrences = dialect.parameterOccurrences(content, project.snapshot, policy);
      let end = 0;
      for (const occurrence of occurrences) {
        const { start, end: occurrenceEnd } = occurrence.range;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(occurrenceEnd) ||
          start < end ||
          occurrenceEnd <= start ||
          occurrenceEnd > content.length
        ) {
          diagnostics.push(unavailable("The grammar returned invalid SQL parameter occurrence ranges."));
          break;
        }
        if (occurrence.index !== count + 1) {
          diagnostics.push({
            ...unavailable(
              "SQL files require each positional parameter exactly once in order; repeated, reordered and gapped placeholders are unsupported.",
            ),
            range: occurrence.range,
          });
          break;
        }
        parts.push(content.slice(end, occurrence.range.start));
        end = occurrence.range.end;
        count += 1;
      }
      parts.push(content.slice(end));
      const resolvedIndexes = new Set(analysis?.parameters.map((parameter) => parameter.index));
      if (
        resolvedIndexes.size !== count ||
        analysis?.parameters.length !== count ||
        [...resolvedIndexes].some((index) => !Number.isSafeInteger(index) || index < 1 || index > count)
      ) {
        diagnostics.push(
          unavailable("The grammar's SQL parameter occurrences do not match its inferred parameter contract."),
        );
      }
    }
  }
  const failed = diagnostics.some((item) => item.severity === "error");
  const row = analysis?.resultKind === "command" ? "never" : rowTypeLiteral(analysis?.columns ?? []);
  const parameters = parameterTypeLiteral(count, analysis?.parameters ?? [], dialect.runtimeSqlModule);
  const type = failed ? "never" : `(...values: ${parameters}) => Query<${row}, ${parameters}>`;
  const text = failed
    ? "declare const query: never; export default query;"
    : `import type { Query, QueryValuePlan } from ${JSON.stringify(dialect.runtimeSqlModule)};\nexport declare const valuePlan: QueryValuePlan;\ndeclare const query: ${type};\nexport default query;\n`;
  const runtime = failed
    ? `export default undefined;\nthrow new SyntaxError(${JSON.stringify(
        diagnostics
          .filter((item) => item.severity === "error")
          .map((item) => `${item.code} (${item.range.line}:${item.range.column}): ${item.message}`)
          .join("\n"),
      )});\n`
    : `import { sql } from ${JSON.stringify(dialect.runtimeSqlModule ?? dialect.sqlModule)};
import { defineQueryValuePlan, withQueryValuePlan } from ${JSON.stringify(dialect.runtimeSqlModule)};
export const valuePlan = defineQueryValuePlan(${JSON.stringify(analysis === undefined ? undefined : buildQueryValuePlan(dialect, analysis, policy, count))});
const parts = ${JSON.stringify(parts)}.map((text) => sql.raw(text));
export default function query(...values) {
  if (values.length !== ${count}) throw new TypeError("SQL file expects ${count} positional parameters");
  const fragments = parts.flatMap((part, index) => index === 0 ? [part] : [sql.value(values[index - 1]), part]);
  return withQueryValuePlan(sql\`\${sql.join(fragments, sql.empty)}\`, valuePlan);
}
`;
  if (
    Buffer.byteLength(text) > DEFAULT_MAX_GENERATED_DECLARATION_BYTES ||
    Buffer.byteLength(runtime) > DEFAULT_MAX_GENERATED_DECLARATION_BYTES
  ) {
    return {
      text: "declare const query: never; export default query;",
      extension: ".ts",
      runtime: 'export default undefined; throw new RangeError("SQL file generated output exceeds the size limit");',
      diagnostics: [
        {
          messageText: "SQL file generated output exceeds the size limit",
          code: 901,
          start: 0,
          length: Math.min(content.length, 1),
        },
      ],
    };
  }
  return {
    text,
    extension: ".ts",
    runtime,
    diagnostics: diagnostics.map((item) => ({
      messageText: `${item.code}: ${item.message}`,
      code: Number(item.code.replace(/^\D+/u, "")) || 901,
      start: item.range.start,
      length: item.range.end - item.range.start,
    })),
  };
}
