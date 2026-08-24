import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { loadSchemaSnapshot, type SchemaSnapshot } from "@typed-sql/schema";
import type { SqlDiagnostic } from "@typed-sql/ast";
import { compileSource } from "./compiler.js";

export interface CheckFileOptions {
  readonly file: string;
  readonly schema: string | SchemaSnapshot;
  readonly project?: string;
  readonly runTypeScript?: boolean;
}

export interface TypeScriptCheckResult {
  readonly exitCode: number;
  readonly output: string;
  readonly command: string;
}

export interface CheckFileResult {
  readonly transformedSource: string;
  readonly sqlDiagnostics: readonly SqlDiagnostic[];
  readonly typeScript?: TypeScriptCheckResult;
  readonly ok: boolean;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

async function findUp(filename: string, start: string): Promise<string | undefined> {
  let directory = resolve(start);
  while (true) {
    const candidate = join(directory, filename);
    if (await exists(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function configPath(fromDirectory: string, target: string): string {
  const value = relative(fromDirectory, target).split(sep).join("/");
  return value.startsWith(".") ? value : `./${value}`;
}

async function tscBinary(start: string): Promise<string> {
  const name = process.platform === "win32" ? "tsc.cmd" : "tsc";
  let directory = resolve(start);
  while (true) {
    const candidate = join(directory, "node_modules", ".bin", name);
    if (await exists(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return name;
    directory = parent;
  }
}

export async function checkFile(options: CheckFileOptions): Promise<CheckFileResult> {
  const file = resolve(options.file);
  const source = await readFile(file, "utf8");
  const schema = typeof options.schema === "string" ? await loadSchemaSnapshot(resolve(options.schema)) : options.schema;
  const compilation = compileSource(source, schema);
  const hasSqlErrors = compilation.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  if (hasSqlErrors || options.runTypeScript === false) {
    return { transformedSource: compilation.transformedSource, sqlDiagnostics: compilation.diagnostics, ok: !hasSqlErrors };
  }

  const directory = dirname(file);
  const basename = file.slice(directory.length + 1);
  const extensionIndex = basename.lastIndexOf(".");
  const stem = extensionIndex === -1 ? basename : basename.slice(0, extensionIndex);
  const extension = extensionIndex === -1 ? ".ts" : basename.slice(extensionIndex);
  const nonce = `${process.pid}-${Date.now()}`;
  const overlay = join(directory, `.typed-sql-${stem}-${nonce}${extension}`);
  const tempConfig = join(directory, `.typed-sql-tsconfig-${nonce}.json`);
  const project = options.project === undefined
    ? await findUp("tsconfig.json", directory)
    : resolve(options.project);
  if (project === undefined) throw new Error(`Could not find tsconfig.json from ${directory}`);
  const config = {
    extends: configPath(directory, project),
    compilerOptions: { composite: false, declaration: false, declarationMap: false, incremental: false, noEmit: true },
    files: [`./${overlay.slice(directory.length + 1)}`],
    include: [],
  };
  await writeFile(overlay, compilation.transformedSource, "utf8");
  await writeFile(tempConfig, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    const binary = await tscBinary(directory);
    const result = spawnSync(binary, ["--project", tempConfig, "--pretty", "false"], { cwd: directory, encoding: "utf8" });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const typeScript = { exitCode: result.status ?? 1, output, command: `${binary} --project ${tempConfig}` };
    return { transformedSource: compilation.transformedSource, sqlDiagnostics: compilation.diagnostics, typeScript, ok: typeScript.exitCode === 0 };
  } finally {
    await Promise.allSettled([unlink(overlay), unlink(tempConfig)]);
  }
}
