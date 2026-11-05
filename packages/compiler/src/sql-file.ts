import { createHash } from "node:crypto";
import {
  type DialectPlugin,
  parameterTypeLiteral,
  rowTypeLiteral,
  type SchemaSnapshot,
  type SqlDiagnostic,
} from "@typed-sql/core";
import type { CompiledQuery } from "./compiler.js";
import { DEFAULT_MAX_GENERATED_DECLARATION_BYTES } from "./compiler.js";
import { analyzeSqlFile } from "./sql-file-analysis.js";
import { buildQueryValuePlan } from "./value-plan.js";

export interface CompileSqlFileOptions {
  readonly source: string;
  readonly dialect: DialectPlugin<SchemaSnapshot, unknown>;
  readonly schema: SchemaSnapshot;
  readonly typePolicy?: unknown;
}

export interface CompileSqlFileResult {
  /** Shared executable analysis for manifests, live verification and plan capture. */
  readonly query?: CompiledQuery;
  /** Grammar diagnostics mapped to the original SQL asset, including original codes and severity. */
  readonly sourceDiagnostics: readonly SqlDiagnostic[];
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

/** JSON literals remain data even when a generated module is embedded in an HTML script. */
function codeLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Generated SQL modules require JSON-serializable literals");
  return json
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** Uses the selected grammar for SQL semantics and placeholder lexing. */
export function compileSqlFile(options: CompileSqlFileOptions): CompileSqlFileResult {
  const { source: content, dialect, typePolicy } = options;
  const policy = typePolicy ?? dialect.defaultTypePolicy;
  const { analysis, diagnostics, parts, bindings, names, count, named, offsets, normalized, logicalParameters } =
    analyzeSqlFile({ ...options, requireRuntimeModule: true });
  const unavailable = (message: string): SqlDiagnostic => ({
    code: "TSQ901",
    severity: "error",
    message,
    range: { start: 0, end: Math.min(content.length, 1), line: 1, column: 1 },
  });
  const failed = diagnostics.some((item) => item.severity === "error");
  const row = analysis?.resultKind === "command" ? "never" : rowTypeLiteral(analysis?.columns ?? []);
  const parameters = parameterTypeLiteral(count, logicalParameters, dialect.runtimeSqlModule);
  const namedType = named
    ? `{ ${logicalParameters.map((parameter, index) => `${codeLiteral(names[index])}: ${parameterTypeLiteral(1, [{ ...parameter, index: 1 }], dialect.runtimeSqlModule).slice("readonly [".length, -1)}`).join("; ")} }`
    : "";
  const args = named ? `(parameters: ${namedType})` : `(...values: ${parameters})`;
  const executableParameters = parameterTypeLiteral(
    bindings.length,
    analysis?.parameters ?? [],
    dialect.runtimeSqlModule,
  );
  const type = failed ? "never" : `${args} => Query<${row}, ${executableParameters}>`;
  const text = failed
    ? "declare const query: never; export default query;"
    : `import type { Query, QueryValuePlan } from ${codeLiteral(dialect.runtimeSqlModule)};\nexport declare const valuePlan: QueryValuePlan;\ndeclare const query: ${type};\nexport default query;\n`;
  const runtime = failed
    ? `export default undefined;\nthrow new SyntaxError(${codeLiteral(
        diagnostics
          .filter((item) => item.severity === "error")
          .map((item) => `${item.code} (${item.range.line}:${item.range.column}): ${item.message}`)
          .join("\n"),
      )});\n`
    : `import { sql } from ${codeLiteral(dialect.runtimeSqlModule ?? dialect.sqlModule)};
import { defineQueryValuePlan, withQueryValuePlan } from ${codeLiteral(dialect.runtimeSqlModule)};
export const valuePlan = defineQueryValuePlan(${codeLiteral(analysis === undefined ? undefined : buildQueryValuePlan(dialect, analysis, policy, bindings.length))});
const parts = ${codeLiteral(parts)}.map((text) => sql.raw(text));
export default function query(${named ? "parameters" : "...values"}) {
  ${
    named
      ? `if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters) || ${codeLiteral(names)}.some((name) => !Object.hasOwn(parameters, name)) || Object.keys(parameters).some((name) => !${codeLiteral(names)}.includes(name))) throw new TypeError("SQL file expects exactly its named parameters");
  const values = ${codeLiteral(names)}.map((name) => parameters[name]);`
      : ""
  }
  if (values.length !== ${count}) throw new TypeError("SQL file expects ${count} positional parameters");
  const fragments = parts.flatMap((part, index) => index === 0 ? [part] : [sql.value(values[${codeLiteral(bindings)}[index - 1]]), part]);
  return withQueryValuePlan(sql\`\${sql.join(fragments, sql.empty)}\`, valuePlan);
}
`;
  if (
    Buffer.byteLength(text) > DEFAULT_MAX_GENERATED_DECLARATION_BYTES ||
    Buffer.byteLength(runtime) > DEFAULT_MAX_GENERATED_DECLARATION_BYTES
  ) {
    return {
      text: "declare const query: never; export default query;",
      sourceDiagnostics: [unavailable("SQL file generated output exceeds the size limit")],
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
  const fingerprint = `sha256:${createHash("sha256").update(`${dialect.id}\0${dialect.grammarVersion}\0${normalized}`).digest("hex")}`;
  const range = { start: 0, end: content.length, line: 1, column: 1 };
  const query: CompiledQuery | undefined =
    failed || analysis === undefined
      ? undefined
      : {
          query: {
            tagName: "sql-file",
            sql: normalized,
            parameterCount: bindings.length,
            insertionPosition: 0,
            range,
            sqlOffsetMap: offsets,
            interpolations: [],
          },
          rowType: row,
          parameterType: executableParameters,
          fingerprint,
          variantFingerprints: [fingerprint],
          semantics: analysis.semantics,
          variants: [
            {
              fingerprint,
              sql: normalized,
              rowType: row,
              parameterType: executableParameters,
              choices: {},
              columns: analysis.columns,
              parameters: analysis.parameters,
              semantics: analysis.semantics,
            },
          ],
        };
  return {
    ...(query === undefined ? {} : { query }),
    sourceDiagnostics: diagnostics,
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
