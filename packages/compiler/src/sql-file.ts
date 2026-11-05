import { createHash } from "node:crypto";
import {
  type DialectAnalysis,
  type DialectPlugin,
  mapQuerySemanticRanges,
  parameterTypeLiteral,
  rowTypeLiteral,
  type SchemaSnapshot,
  type SourceRange,
  type SqlDiagnostic,
} from "@typed-sql/core";
import type { CompiledQuery } from "./compiler.js";
import { DEFAULT_MAX_GENERATED_DECLARATION_BYTES, DEFAULT_MAX_SOURCE_BYTES } from "./compiler.js";
import { positionRange } from "./scanner.js";
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
  const parts: string[] = [];
  const bindings: number[] = [];
  const lastBindingRange = new Map<number, SourceRange>();
  const names: string[] = [];
  const nameIndexes = new Map<string, number>();
  const offsets: number[] = [];
  let normalized = "";
  let count = 0;
  let named = false;
  let analysis: DialectAnalysis | undefined;
  const mapRange = (range: SourceRange): SourceRange => {
    const start = offsets[range.start] ?? content.length;
    const end = range.end <= range.start ? start : (offsets[range.end - 1] ?? content.length - 1) + 1;
    return positionRange(content, start, end);
  };
  if (diagnostics.length === 0) {
    if (dialect.parameterOccurrences === undefined)
      diagnostics.push(unavailable("This grammar does not support SQL-file parameter binding."));
    else
      try {
        const occurrences = dialect.parameterOccurrences(content, schema, policy);
        named = occurrences.some((occurrence) => occurrence.name !== undefined);
        if (named && occurrences.some((occurrence) => occurrence.name === undefined))
          diagnostics.push(unavailable("SQL files cannot mix named and positional parameters."));
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
          let index = occurrence.index;
          if (named) {
            const name = occurrence.name!;
            if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
              diagnostics.push(unavailable("Invalid named SQL parameter."));
              break;
            }
            const existing = nameIndexes.get(name);
            if (existing === undefined) {
              names.push(name);
              nameIndexes.set(name, names.length);
            }
            index = existing ?? names.length;
          }
          if (!Number.isSafeInteger(index) || index < 1 || index > 65_535) {
            diagnostics.push({ ...unavailable("Invalid SQL parameter index."), range: occurrence.range });
            break;
          }
          parts.push(content.slice(end, start));
          for (let offset = end; offset < start; offset += 1) offsets.push(offset);
          const marker = dialect.placeholder(bindings.length + 1);
          for (let offset = 0; offset < marker.length; offset += 1)
            offsets.push(offset === marker.length - 1 ? occurrenceEnd - 1 : start);
          normalized += parts[parts.length - 1] + marker;
          bindings.push(index - 1);
          lastBindingRange.set(index - 1, occurrence.range);
          count = Math.max(count, index);
          end = occurrenceEnd;
        }
        parts.push(content.slice(end));
        normalized += content.slice(end);
        for (let offset = end; offset < content.length; offset += 1) offsets.push(offset);
        if (new Set(bindings).size !== count)
          diagnostics.push(
            unavailable("SQL parameter indexes must be contiguous from 1; unused gaps are unsupported."),
          );
        if (diagnostics.length === 0) {
          const resolved = dialect.analyze(normalized, schema, policy, { runtimeValidation: true });
          analysis = {
            ...resolved,
            columns: resolved.columns.map((column) => ({ ...column, range: mapRange(column.range) })),
            parameters: resolved.parameters,
            semantics: mapQuerySemanticRanges(resolved.semantics, mapRange),
          };
          diagnostics.push(
            ...resolved.diagnostics.map((diagnostic) => ({
              ...diagnostic,
              range: mapRange(diagnostic.range),
              ...(diagnostic.fix === undefined
                ? {}
                : { fix: { ...diagnostic.fix, range: mapRange(diagnostic.fix.range) } }),
            })),
          );
          const indexes = new Set(analysis.parameters.map((parameter) => parameter.index));
          if (
            indexes.size !== bindings.length ||
            analysis.parameters.length !== bindings.length ||
            [...indexes].some((index) => !Number.isSafeInteger(index) || index < 1 || index > bindings.length)
          )
            diagnostics.push(
              unavailable("The grammar's SQL parameter occurrences do not match its inferred parameter contract."),
            );
        }
      } catch (error) {
        const failure = error as { message?: string; range?: SourceRange };
        diagnostics.push({
          ...unavailable(failure.message ?? "Invalid SQL file parameters."),
          ...(failure.range === undefined ? {} : { range: failure.range }),
        });
      }
  }
  const groupedParameters = new Map<number, NonNullable<typeof analysis>["parameters"][number][]>();
  for (const parameter of analysis?.parameters ?? []) {
    const binding = bindings[parameter.index - 1]!;
    const group = groupedParameters.get(binding);
    if (group === undefined) groupedParameters.set(binding, [parameter]);
    else group.push(parameter);
  }
  const logicalParameters = Array.from({ length: count }, (_, index) => {
    const values = groupedParameters.get(index) ?? [];
    const first = values[0];
    if (first === undefined) return undefined;
    if (
      values.some(
        (parameter) =>
          parameter.tsType !== first.tsType ||
          parameter.databaseType !== first.databaseType ||
          JSON.stringify(parameter.json) !== JSON.stringify(first.json) ||
          JSON.stringify(parameter.runtimeType) !== JSON.stringify(first.runtimeType) ||
          JSON.stringify(parameter.scalarJsonShape) !== JSON.stringify(first.scalarJsonShape) ||
          parameter.acceptsJsonInput !== first.acceptsJsonInput,
      )
    )
      diagnostics.push({
        ...unavailable("Repeated SQL parameter has incompatible inferred types; use consistent explicit casts."),
        range: lastBindingRange.get(index) ?? unavailable("").range,
      });
    return { ...first, index: index + 1, nullable: values.every((value) => value.nullable) };
  }).filter((parameter) => parameter !== undefined);
  const failed = diagnostics.some((item) => item.severity === "error");
  const row = analysis?.resultKind === "command" ? "never" : rowTypeLiteral(analysis?.columns ?? []);
  const parameters = parameterTypeLiteral(count, logicalParameters, dialect.runtimeSqlModule);
  const namedType = `{ ${logicalParameters.map((parameter, index) => `${JSON.stringify(names[index])}: ${parameterTypeLiteral(1, [{ ...parameter, index: 1 }], dialect.runtimeSqlModule).slice("readonly [".length, -1)}`).join("; ")} }`;
  const args = named ? `(parameters: ${namedType})` : `(...values: ${parameters})`;
  const executableParameters = parameterTypeLiteral(
    bindings.length,
    analysis?.parameters ?? [],
    dialect.runtimeSqlModule,
  );
  const type = failed ? "never" : `${args} => Query<${row}, ${executableParameters}>`;
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
export const valuePlan = defineQueryValuePlan(${JSON.stringify(analysis === undefined ? undefined : buildQueryValuePlan(dialect, analysis, policy, bindings.length))});
const parts = ${JSON.stringify(parts)}.map((text) => sql.raw(text));
export default function query(${named ? "parameters" : "...values"}) {
  ${
    named
      ? `if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters) || ${JSON.stringify(names)}.some((name) => !Object.hasOwn(parameters, name)) || Object.keys(parameters).some((name) => !${JSON.stringify(names)}.includes(name))) throw new TypeError("SQL file expects exactly its named parameters");
  const values = ${JSON.stringify(names)}.map((name) => parameters[name]);`
      : ""
  }
  if (values.length !== ${count}) throw new TypeError("SQL file expects ${count} positional parameters");
  const fragments = parts.flatMap((part, index) => index === 0 ? [part] : [sql.value(values[${JSON.stringify(bindings)}[index - 1]]), part]);
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
