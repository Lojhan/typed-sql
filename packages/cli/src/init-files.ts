import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const initHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export interface InitFileState {
  readonly text: string;
  readonly mode: number;
}

export function assertInitProjectPath(root: string, file: string): void {
  const path = relative(root, resolve(file));
  if (
    !isAbsolute(file) ||
    file !== resolve(file) ||
    path === "" ||
    path.startsWith("..") ||
    isAbsolute(path) ||
    path.split(/[\\/]/u)[0] === ".typed-sql"
  )
    throw new Error(`Invalid setup project path: ${file}`);
}

export async function syncInitDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readInitFile(file: string): Promise<InitFileState | undefined> {
  try {
    const existing = await lstat(file);
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error(`Setup requires a regular non-symlink file: ${file}`);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16 * 1024 * 1024)
        throw new Error(`Setup requires a regular file of at most 16 MiB: ${file}`);
      return { text: await handle.readFile("utf8"), mode: info.mode & 0o777 };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Reject escapes and symlinked ancestors before reading or replacing project files. */
export async function checkInitPath(root: string, file: string, createParents = false): Promise<void> {
  const path = relative(root, file);
  if (!path || path.startsWith("..") || isAbsolute(path))
    throw new Error(`Setup path is outside the application: ${file}`);
  let current = root;
  const parts = path.split(/[\\/]/u);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const parent = index < parts.length - 1;
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (!createParents || !parent) return;
      await mkdir(current, { mode: current === join(root, ".typed-sql") ? 0o700 : 0o755 }).catch((failure: unknown) => {
        if (!(failure instanceof Error && "code" in failure && failure.code === "EEXIST")) throw failure;
      });
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || (parent ? !info.isDirectory() : !info.isFile()))
      throw new Error(`Setup refuses a symlink or unexpected file type: ${current}`);
  }
}

export async function assertInitFile(
  root: string,
  file: string,
  expected: string | null,
): Promise<InitFileState | undefined> {
  await checkInitPath(root, file);
  const current = await readInitFile(file);
  if ((current === undefined ? null : initHash(current.text)) !== expected)
    throw new Error(`Concurrent edit detected; regenerate the setup plan: ${file}`);
  return current;
}

export async function writeInitFile(
  root: string,
  file: string,
  content: string,
  expected: string | null,
  mode?: number,
): Promise<void> {
  await checkInitPath(root, file, true);
  const previous = await assertInitFile(root, file, expected);
  const temporary = join(dirname(file), `.typed-sql-init-${randomUUID()}`);
  try {
    const handle = await open(temporary, "wx", mode ?? previous?.mode ?? 0o666 & ~process.umask());
    try {
      if (previous !== undefined || mode !== undefined) await handle.chmod(mode ?? previous!.mode);
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertInitFile(root, file, expected);
    if (expected === null)
      await link(temporary, file); // Atomic creation must never overwrite a new user file.
    else await rename(temporary, file);
    await syncInitDirectory(dirname(file));
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}
