import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface ListProjectSourceFilesOptions {
  readonly project: string;
  readonly entryFile?: string;
  readonly cwd?: string;
  readonly typeScriptTimeoutMs?: number;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
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

function isApplicationSource(file: string): boolean {
  return (
    !file.split(sep).includes("node_modules") && !/\.d\.(?:c|m)?ts$/u.test(file) && /\.(?:c|m)?(?:j|t)sx?$/u.test(file)
  );
}

/** Uses the workspace TypeScript executable only for tsconfig file discovery, never compiler analysis. */
export async function listProjectSourceFiles(options: ListProjectSourceFilesOptions): Promise<readonly string[]> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const project = resolve(cwd, options.project);
  const timeout = options.typeScriptTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new TypeError("typeScriptTimeoutMs must be a positive safe integer");
  }
  let binary = await tscBinary(cwd);
  let prefix: string[] = [];
  try {
    const require = createRequire(join(cwd, "package.json"));
    const manifestFile = require.resolve("typescript/package.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { bin: { tsc: string } };
    binary = process.execPath;
    prefix = [resolve(dirname(manifestFile), manifest.bin.tsc)];
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND")) throw error;
  }
  const temporary = options.entryFile === undefined ? undefined : await mkdtemp(join(tmpdir(), "typed-sql-project-"));
  const selectedProject = temporary === undefined ? project : join(temporary, "tsconfig.json");
  try {
    if (temporary !== undefined) {
      const shown = await execFile(binary, [...prefix, "--project", project, "--showConfig"], {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout,
      });
      const effective = JSON.parse(shown.stdout) as { compilerOptions?: { typeRoots?: string[] } };
      const typeRoots = effective.compilerOptions?.typeRoots?.map((path) => resolve(dirname(project), path)) ?? [];
      if (effective.compilerOptions?.typeRoots === undefined)
        for (let directory = dirname(project); ; directory = dirname(directory)) {
          typeRoots.push(join(directory, "node_modules", "@types"));
          if (dirname(directory) === directory) break;
        }
      await writeFile(
        selectedProject,
        JSON.stringify({
          extends: project,
          compilerOptions: {
            composite: false,
            declaration: false,
            declarationMap: false,
            incremental: false,
            noEmit: true,
            typeRoots,
          },
          files: [resolve(cwd, options.entryFile!)],
          include: [],
        }),
      );
    }
    const result = await execFile(
      binary,
      [...prefix, "--project", selectedProject, "--listFilesOnly", "--pretty", "false"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout,
      },
    );
    return [
      ...new Set(
        result.stdout
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((file) => (isAbsolute(file) ? file : resolve(cwd, file))),
      ),
    ]
      .filter(isApplicationSource)
      .sort();
  } catch (error) {
    const candidate = error as {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly message?: string;
      readonly code?: number;
      readonly killed?: boolean;
    };
    // Native list mode can enumerate the complete graph while reporting config errors. The
    // checking process reports those diagnostics at their real positions; timeouts still fail.
    if (options.entryFile !== undefined && (candidate.code === 1 || candidate.code === 2) && !candidate.killed) {
      const files = (candidate.stdout ?? "")
        .split(/\r?\n/u)
        .filter((file) => isAbsolute(file) && isApplicationSource(file));
      if (files.length > 0) return [...new Set(files)].sort();
    }
    throw new Error(
      `Could not enumerate TypeScript project ${project}: ${`${candidate.stdout ?? ""}${candidate.stderr ?? ""}${candidate.message ?? ""}`.trim()}`,
    );
  } finally {
    if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
  }
}
