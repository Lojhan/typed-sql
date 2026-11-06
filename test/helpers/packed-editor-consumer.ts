import { execFile as callback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensurePackedEditorSdk } from "./packed-editor-sdk.js";

const execFile = promisify(callback);
export function packedConsumerOverrides(
  workspace: string,
  dependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...dependencies,
    tsx: `link:${join(workspace, "node_modules", "tsx")}`,
    "@types/node": `link:${join(workspace, "node_modules", "@types", "node")}`,
    "@types/pg": `link:${join(workspace, "node_modules", "@types", "pg")}`,
    "magic-string": `link:${join(workspace, "packages", "build", "node_modules", "magic-string")}`,
    "@jridgewell/remapping": `link:${join(workspace, "packages", "build", "node_modules", "@jridgewell", "remapping")}`,
    picomatch: `link:${join(workspace, "packages", "build", "node_modules", "picomatch")}`,
    "jsonc-parser": `link:${join(workspace, "packages", "cli", "node_modules", "jsonc-parser")}`,
    "proper-lockfile": `link:${join(workspace, "packages", "cli", "node_modules", "proper-lockfile")}`,
    "@typed-sql/typescript-preview": `link:${join(workspace, "packages", "ts-bridge", "node_modules", "@typed-sql", "typescript-preview")}`,
    "vscode-jsonrpc": `link:${join(workspace, "packages", "language-server", "node_modules", "vscode-jsonrpc")}`,
    "vscode-languageserver": `link:${join(workspace, "packages", "language-server", "node_modules", "vscode-languageserver")}`,
    "vscode-languageserver-textdocument": `link:${join(workspace, "packages", "language-server", "node_modules", "vscode-languageserver-textdocument")}`,
  };
}
interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}
/** An independent driver-free packed closure for native grammar LSP checks. */
export async function createPackedNativeEditorConsumer(
  workspace: string,
  env: NodeJS.ProcessEnv,
): Promise<{ consumer: string; close(): Promise<void> }> {
  const temporary = await mkdtemp(join(tmpdir(), "typed-sql-packed-native-editors-"));
  const consumer = join(temporary, "consumer");
  const tarballs = join(temporary, "tarballs");
  try {
    await ensurePackedEditorSdk(workspace);
    await mkdir(consumer);
    await mkdir(tarballs);
    const packages = new Map<string, Manifest>();
    for (const entry of await readdir(join(workspace, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = await readFile(join(workspace, "packages", entry.name, "package.json"), "utf8").catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (source === undefined) continue;
      const manifest = JSON.parse(source) as Manifest;
      packages.set(manifest.name, manifest);
    }
    const dependencies: Record<string, string> = {};
    const pack = async (name: string): Promise<void> => {
      if (dependencies[name] !== undefined) return;
      const manifest = packages.get(name);
      if (!manifest) throw new Error(`No workspace package ${name}`);
      const archive = join(tarballs, `${name.replace(/^@/u, "").replaceAll("/", "-")}-${manifest.version}.tgz`);
      dependencies[name] = `file:${archive}`;
      for (const dependency of Object.keys(manifest.dependencies ?? {}))
        if (packages.has(dependency)) await pack(dependency);
      await execFile("pnpm", ["--silent", "--filter", name, "pack", "--out", archive], { cwd: workspace, env });
    };
    for (const name of ["@typed-sql/cli", "@typed-sql/language-server", "@typed-sql/sqlserver", "@typed-sql/duckdb"])
      await pack(name);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify(
        {
          private: true,
          type: "module",
          dependencies: { ...dependencies, typescript: `link:${join(workspace, "node_modules/typescript")}` },
          pnpm: { overrides: packedConsumerOverrides(workspace, dependencies) },
        },
        null,
        2,
      ),
    );
    await execFile(
      "pnpm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-frozen-lockfile",
        "--store-dir",
        join(temporary, "pnpm-store"),
      ],
      { cwd: consumer, env: { ...env, CI: "true" } },
    );
    await writeFile(
      join(consumer, "driver-free.mjs"),
      `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      for (const name of ["pg", "mysql2", "mssql", "tedious", "msnodesqlv8", "koffi", "@duckdb/node-api", "@duckdb/node-bindings"]) {
        assert.throws(() => require.resolve(name), error => error.code === "MODULE_NOT_FOUND", name + " must remain application-owned");
      }
    `,
    );
    await execFile(process.execPath, [join(consumer, "driver-free.mjs")], { cwd: consumer, env });
    return { consumer, close: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
