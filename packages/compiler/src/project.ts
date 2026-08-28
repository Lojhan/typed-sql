import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface ListProjectSourceFilesOptions {
  readonly project: string;
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
  const binary = await tscBinary(cwd);
  try {
    const result = await execFile(binary, ["--project", project, "--listFilesOnly", "--pretty", "false"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    });
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
    const candidate = error as { readonly stdout?: string; readonly stderr?: string; readonly message?: string };
    throw new Error(
      `Could not enumerate TypeScript project ${project}: ${`${candidate.stdout ?? ""}${candidate.stderr ?? ""}${candidate.message ?? ""}`.trim()}`,
    );
  }
}
