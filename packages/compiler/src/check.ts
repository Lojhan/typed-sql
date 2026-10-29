import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DialectPlugin, SchemaSnapshot, SqlDiagnostic } from "@typed-sql/core";
import { analyzeSource, SOURCE_ANALYSIS_FORMAT_VERSION, type SourceAnalysisResult } from "./analysis.js";
import { findConfig, type NativeCheckResult, runNativeCheck } from "./native-check.js";

export interface CheckFileOptions<Snapshot extends SchemaSnapshot = SchemaSnapshot, Policy = unknown> {
  readonly file: string;
  readonly schema: string | SchemaSnapshot;
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly typePolicy?: Policy;
  readonly project?: string;
  readonly runTypeScript?: boolean;
  readonly maxStructuralVariants?: number;
  readonly maxSourceBytes?: number;
  readonly maxQueries?: number;
  readonly maxGeneratedDeclarationBytes?: number;
  readonly typeScriptTimeoutMs?: number;
}

export interface TypeScriptCheckResult extends NativeCheckResult {}

export interface CheckFileResult {
  readonly analysis: SourceAnalysisResult;
  readonly transformedSource: string;
  readonly sqlDiagnostics: readonly SqlDiagnostic[];
  readonly typeScript?: TypeScriptCheckResult;
  readonly files?: readonly { readonly file: string; readonly analysis: SourceAnalysisResult }[];
  readonly ok: boolean;
}

export interface CheckProjectOptions<Snapshot extends SchemaSnapshot = SchemaSnapshot, Policy = unknown>
  extends Omit<CheckFileOptions<Snapshot, Policy>, "file" | "runTypeScript"> {
  readonly project: string;
}

export interface CheckProjectResult {
  readonly files: readonly { readonly file: string; readonly analysis: SourceAnalysisResult }[];
  readonly typeScript: TypeScriptCheckResult;
  readonly ok: boolean;
}

async function analyzer<Snapshot extends SchemaSnapshot, Policy>(
  options: Omit<CheckFileOptions<Snapshot, Policy>, "file">,
) {
  const schema =
    typeof options.schema === "string"
      ? options.dialect.validateSnapshot(JSON.parse(await readFile(resolve(options.schema), "utf8")) as unknown)
      : options.dialect.validateSnapshot(options.schema);
  return (file: string, source: string): SourceAnalysisResult =>
    analyzeSource(
      {
        formatVersion: SOURCE_ANALYSIS_FORMAT_VERSION,
        source: { id: file, text: source },
        compiler: {
          ...(options.maxStructuralVariants === undefined
            ? {}
            : { maxStructuralVariants: options.maxStructuralVariants }),
          ...(options.maxSourceBytes === undefined ? {} : { maxSourceBytes: options.maxSourceBytes }),
          ...(options.maxQueries === undefined ? {} : { maxQueries: options.maxQueries }),
          ...(options.maxGeneratedDeclarationBytes === undefined
            ? {}
            : { maxGeneratedDeclarationBytes: options.maxGeneratedDeclarationBytes }),
        },
      },
      {
        dialect: options.dialect,
        schema,
        ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
      },
    );
}

function timeout(value = 60_000): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError("typeScriptTimeoutMs must be a positive safe integer");
  return value;
}

/** Check one entry file and transform every application module it imports in memory. */
export async function checkFile<Snapshot extends SchemaSnapshot, Policy>(
  options: CheckFileOptions<Snapshot, Policy>,
): Promise<CheckFileResult> {
  const milliseconds = timeout(options.typeScriptTimeoutMs);
  const file = resolve(options.file);
  const analyze = await analyzer(options);
  const analysis = analyze(file, await readFile(file, "utf8"));
  const analyses = new Map([[file, analysis]]);
  const hasSqlErrors = analysis.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  if (hasSqlErrors || options.runTypeScript === false)
    return {
      analysis,
      transformedSource: analysis.transformedSource,
      sqlDiagnostics: analysis.diagnostics,
      files: [{ file, analysis }],
      ok: !hasSqlErrors,
    };
  const project = options.project === undefined ? await findConfig(dirname(file)) : resolve(options.project);
  if (project === undefined) throw new Error(`Could not find tsconfig.json from ${dirname(file)}`);
  const typeScript = await runNativeCheck({ project, file, timeout: milliseconds, analyze, analyses });
  const sqlDiagnostics = [...analyses.values()].flatMap((result) => result.diagnostics);
  return {
    analysis,
    transformedSource: analysis.transformedSource,
    sqlDiagnostics,
    typeScript,
    files: [...analyses].map(([file, analysis]) => ({ file, analysis })),
    ok: typeScript.exitCode === 0 && !sqlDiagnostics.some((diagnostic) => diagnostic.severity === "error"),
  };
}

/** Check the complete configured project with shared, original-path query overlays. */
export async function checkProject<Snapshot extends SchemaSnapshot, Policy>(
  options: CheckProjectOptions<Snapshot, Policy>,
): Promise<CheckProjectResult> {
  const analyze = await analyzer(options);
  const analyses = new Map<string, SourceAnalysisResult>();
  const typeScript = await runNativeCheck({
    project: resolve(options.project),
    timeout: timeout(options.typeScriptTimeoutMs),
    analyze,
    analyses,
  });
  const files = [...analyses].sort(([a], [b]) => a.localeCompare(b)).map(([file, analysis]) => ({ file, analysis }));
  return {
    files,
    typeScript,
    ok:
      typeScript.exitCode === 0 &&
      !files.some(({ analysis }) => analysis.diagnostics.some((diagnostic) => diagnostic.severity === "error")),
  };
}
