import {
  type DialectPlugin,
  parameterTypeLiteral,
  rowTypeLiteral,
  type SchemaSnapshot,
  type SqlDiagnostic,
} from "@typed-sql/core";
import { DEFAULT_MAX_GENERATED_DECLARATION_BYTES, DEFAULT_MAX_SOURCE_BYTES } from "./compiler.js";
import { buildQueryValuePlan } from "./value-plan.js";

export interface CompileSqlFileOptions {
  readonly source: string;
  readonly dialect: DialectPlugin<SchemaSnapshot, unknown>;
  readonly schema: SchemaSnapshot;
  readonly typePolicy?: unknown;
}

export interface CompileSqlFileResult {
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
export function compileSqlFile(options: CompileSqlFileOptions): CompileSqlFileResult {
  const { source: content, dialect, typePolicy, schema } = options;
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
    diagnostics.length === 0 ? dialect.analyze(content, schema, policy, { runtimeValidation: true }) : undefined;
  diagnostics.push(...(analysis?.diagnostics ?? []));
  const parts: string[] = [];
  let count = 0;
  if (!diagnostics.some((item) => item.severity === "error")) {
    if (dialect.parameterOccurrences === undefined)
      diagnostics.push(unavailable("This grammar does not support SQL-file parameter binding."));
    else {
      const occurrences = dialect.parameterOccurrences(content, schema, policy);
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
