import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { Diagnostic } from "typescript/unstable/async";
import type { SourceAnalysisResult } from "./analysis.js";
import { listProjectSourceFiles } from "./project.js";
import { assertTypeScriptCompilerVersion } from "./typescript.js";

export interface NativeCheckResult {
  readonly exitCode: number;
  readonly output: string;
  readonly command: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findConfig(start: string): Promise<string | undefined> {
  for (let directory = resolve(start); ; directory = dirname(directory)) {
    const candidate = join(directory, "tsconfig.json");
    if (await exists(candidate)) return candidate;
    if (dirname(directory) === directory) return undefined;
  }
}

function originalOffset(analysis: SourceAnalysisResult, offset: number): number {
  let shift = 0;
  for (const insertion of analysis.insertions) {
    const start = insertion.position + shift;
    if (offset <= start) break;
    if (offset <= start + insertion.length) return insertion.position;
    shift += insertion.length;
  }
  return Math.min(analysis.source.length, Math.max(0, offset - shift));
}

function formatDiagnostic(diagnostic: Diagnostic, analyses: ReadonlyMap<string, SourceAnalysisResult>): string {
  let location = "";
  if (diagnostic.fileName !== undefined) {
    const file = resolve(diagnostic.fileName);
    const analysis = analyses.get(file);
    const source = analysis?.source ?? readFileSync(file, "utf8");
    const offset = analysis === undefined ? diagnostic.pos : originalOffset(analysis, diagnostic.pos);
    const prefix = source.slice(0, Math.max(0, offset));
    const line = prefix.split("\n").length;
    const column = prefix.length - prefix.lastIndexOf("\n");
    location = `${file}(${line},${column}): `;
  }
  const category = diagnostic.category === 1 ? "error" : "warning";
  const related = diagnostic.messageChain?.map((message) => `\n  ${message.text}`).join("") ?? "";
  return `${location}${category} TS${diagnostic.code}: ${diagnostic.text}${related}\n`;
}

/** Uses only the application's exact stable TypeScript package, never the preview bridge. */
export async function runNativeCheck(options: {
  readonly project: string;
  readonly file?: string;
  readonly timeout: number;
  readonly analyze: (file: string, source: string) => SourceAnalysisResult;
  readonly analyses: Map<string, SourceAnalysisResult>;
}): Promise<NativeCheckResult> {
  const cwd = dirname(options.project);
  const require = createRequire(join(cwd, "package.json"));
  const metadata = JSON.parse(await readFile(require.resolve("typescript/package.json"), "utf8")) as {
    version: string;
  };
  assertTypeScriptCompilerVersion(metadata.version);
  const files = await listProjectSourceFiles({
    project: options.project,
    cwd,
    typeScriptTimeoutMs: options.timeout,
    ...(options.file === undefined ? {} : { entryFile: options.file }),
  });
  for (const file of files) {
    const key = resolve(file);
    if (!options.analyses.has(key)) options.analyses.set(key, options.analyze(key, await readFile(key, "utf8")));
  }
  const virtualProject = options.file === undefined ? undefined : join(cwd, `.typed-sql-check-${randomUUID()}.json`);
  const worker = new Worker(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "../dist/packages/compiler/src/native-check-worker.js"
        : "./native-check-worker.js",
      import.meta.url,
    ),
    {
      execArgv: process.execArgv.filter(
        (argument, index, args) => !argument.startsWith("--input-type") && args[index - 1] !== "--input-type",
      ),
      workerData: {
        apiUrl: pathToFileURL(require.resolve("typescript/unstable/async")).href,
        cwd,
        project: options.project,
        file: options.file,
        virtualProject,
        files: Object.fromEntries([...options.analyses].map(([file, analysis]) => [file, analysis.transformedSource])),
      },
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  const exited = new Promise<void>((resolveExit) => worker.once("exit", () => resolveExit()));
  try {
    const diagnostics = await new Promise<readonly Diagnostic[]>((resolveCheck, reject) => {
      timer = setTimeout(() => reject(new Error(`TypeScript checking exceeded ${options.timeout}ms`)), options.timeout);
      worker.once("error", reject);
      worker.once("exit", (code) =>
        reject(new Error(`TypeScript checker exited before returning diagnostics (${code})`)),
      );
      worker.once("message", (message: { diagnostics?: readonly Diagnostic[]; error?: string }) => {
        completed = true;
        if (message.error !== undefined) reject(new Error(message.error));
        else if (message.diagnostics === undefined)
          reject(new Error("TypeScript checker returned no diagnostics result"));
        else resolveCheck(message.diagnostics);
      });
    });
    const unique = [
      ...new Map(diagnostics.map((item) => [`${item.fileName}:${item.pos}:${item.code}:${item.text}`, item])).values(),
    ];
    return {
      exitCode: unique.some((diagnostic) => diagnostic.category === 1) ? 1 : 0,
      output: unique
        .map((diagnostic) =>
          formatDiagnostic(
            diagnostic.fileName === virtualProject ? { ...diagnostic, fileName: options.project, pos: 0 } : diagnostic,
            options.analyses,
          ),
        )
        .join(""),
      command: `typescript ${metadata.version} --project ${options.project}`,
    };
  } finally {
    clearTimeout(timer);
    if (completed) await exited;
    else await worker.terminate();
  }
}
