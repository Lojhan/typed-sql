import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export const contentHash = (source: string): string => createHash("sha256").update(source).digest("hex");
const inside = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);
const hidden = new Set(["node_modules", ".git", ".typed-sql", "dist", ".vitepress"]);

export class WorkspaceFiles {
  readonly root: string;
  private readonly writes = new Map<string, Promise<void>>();
  constructor(
    root: string,
    readonly readRoots: readonly string[],
    readonly writeRoots: readonly string[],
  ) {
    this.root = resolve(root);
    for (const path of [...readRoots, ...writeRoots]) {
      if (!path || isAbsolute(path) || !inside(this.root, resolve(this.root, path)))
        throw new WorkspaceError("ROOT", "Workspace roots must remain inside the project");
    }
  }
  private async scopedPath(file: string, write = false): Promise<string> {
    if (
      !file ||
      file.includes("\0") ||
      isAbsolute(file) ||
      file.split(/[\\/]/u).some((p) => p === ".." || hidden.has(p))
    )
      throw new WorkspaceError("PATH", "Choose a project-relative file inside an allowed workspace root");
    const path = resolve(this.root, file);
    const roots = write ? this.writeRoots : [...this.readRoots, ...this.writeRoots];
    if (!inside(this.root, path) || !roots.some((root) => inside(resolve(this.root, root), path)))
      throw new WorkspaceError("PATH", "File is outside the configured workspace roots", 403);
    await this.assertPathTree(path);
    return path;
  }
  async path(file: string, write = false): Promise<string> {
    const path = await this.scopedPath(file, write);
    if (!/\.(?:[cm]?ts|tsx|sql)$/u.test(path))
      throw new WorkspaceError("EXTENSION", "Only TypeScript and SQL files can be edited");
    return path;
  }
  /** Creates an ordinary repository directory, including missing parents, without replacing anything. */
  async createFolder(folder: string): Promise<{ folder: string }> {
    const path = await this.scopedPath(folder, true);
    return this.locked([path], async () => {
      await this.scopedPath(folder, true);
      let current = this.root;
      const parts = relative(this.root, path).split(sep).filter(Boolean);
      for (const [index, part] of parts.entries()) {
        current = join(current, part);
        await this.assertPathTree(current);
        try {
          // The final mkdir is deliberately non-recursive: one concurrent creator wins atomically.
          await mkdir(current, { mode: 0o700 });
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          await this.assertPathTree(current);
          if (index === parts.length - 1 || !(await lstat(current)).isDirectory())
            throw new WorkspaceError("FOLDER_CONFLICT", "A file or folder already exists at this path", 409);
        }
        await this.assertPathTree(current);
      }
      if (!parts.length) throw new WorkspaceError("FOLDER_CONFLICT", "The project folder already exists", 409);
      return { folder: relative(this.root, path).split(sep).join("/") };
    });
  }
  private async assertPathTree(path: string): Promise<void> {
    let cursor = path;
    while (inside(this.root, cursor)) {
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink())
          throw new WorkspaceError("SYMLINK", "Symlinks are not editable through the workspace", 403);
        const actual = await realpath(cursor);
        if (!inside(await realpath(this.root), actual))
          throw new WorkspaceError("PATH", "File escapes the project", 403);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOTDIR")
          throw new WorkspaceError("FOLDER_CONFLICT", "A parent path is an ordinary file, not a folder", 409);
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (cursor === this.root) break;
      cursor = dirname(cursor);
    }
  }
  private async locked<T>(paths: readonly string[], action: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(paths.map((path) => resolve(this.root, path)))].sort();
    const acquire = async (index: number): Promise<T> => {
      const path = ordered[index];
      if (path === undefined) return action();
      const previous = this.writes.get(path) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      this.writes.set(path, tail);
      await previous;
      try {
        return await acquire(index + 1);
      } finally {
        release();
        if (this.writes.get(path) === tail) this.writes.delete(path);
      }
    };
    return acquire(0);
  }
  private async readSource(path: string): Promise<string> {
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ELOOP")
        throw new WorkspaceError("SYMLINK", "Symlinks are not editable through the workspace", 403);
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new WorkspaceError("FILE", "Select an ordinary project file");
      if (info.size > 512 * 1024) throw new WorkspaceError("FILE_LIMIT", "File exceeds the 512 KiB editor limit");
      const source = await handle.readFile("utf8");
      if (Buffer.byteLength(source) > 512 * 1024)
        throw new WorkspaceError("FILE_LIMIT", "File exceeds the 512 KiB editor limit");
      return source;
    } finally {
      await handle.close();
    }
  }
  async read(file: string) {
    const path = await this.path(file);
    const source = await this.readSource(path);
    return { file, source, revision: contentHash(source) };
  }
  async save(file: string, source: string, revision: string | null) {
    await this.path(file, true);
    return this.locked([file], () => this.saveLocked(file, source, revision));
  }
  private async saveLocked(file: string, source: string, revision: string | null) {
    if (Buffer.byteLength(source) > 512 * 1024)
      throw new WorkspaceError("FILE_LIMIT", "File exceeds the 512 KiB editor limit");
    const path = await this.path(file, true);
    let current: string | null = null;
    try {
      current = contentHash(await this.readSource(path));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (current !== revision)
      throw new WorkspaceError(
        "FILE_CONFLICT",
        "File changed on disk. Reload or save to a new path before continuing.",
        409,
      );
    await mkdir(dirname(path), { recursive: true });
    await this.path(file, true);
    const temporary = join(dirname(path), `.playground-${randomUUID()}`);
    try {
      await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
      await this.path(file, true);
      let observed: string | null = null;
      try {
        observed = contentHash(await this.readSource(path));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (observed !== revision)
        throw new WorkspaceError("FILE_CONFLICT", "File changed while saving. Reload or save to a new path.", 409);
      if (revision === null) {
        // link is an atomic no-replace publication; a concurrently created file is never overwritten.
        try {
          await link(temporary, path);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST")
            throw new WorkspaceError("FILE_CONFLICT", "Another file already exists at this path", 409);
          throw error;
        }
      } else await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return { file, revision: contentHash(source) };
  }
  async move(from: string, to: string, revision: string) {
    await this.path(from, true);
    await this.path(to, true);
    if (resolve(this.root, from) === resolve(this.root, to))
      throw new WorkspaceError("PATH", "Choose a different destination");
    return this.locked([from, to], async () => {
      const source = await this.read(from);
      if (source.revision !== revision) throw new WorkspaceError("FILE_CONFLICT", "File changed on disk", 409);
      const target = await this.saveLocked(to, source.source, null);
      const latest = await this.read(from);
      if (latest.revision !== revision)
        throw new WorkspaceError(
          "FILE_CONFLICT",
          `A copy was saved to ${to}, but the source changed and was retained. Review both files.`,
          409,
        );
      await unlink(await this.path(from, true));
      return target;
    });
  }
  async inventory(): Promise<{ files: string[]; folders: string[] }> {
    const result = new Set<string>();
    const folders = new Set<string>();
    const visited = new Set<string>();
    const visit = async (directory: string) => {
      if (visited.has(directory)) return;
      visited.add(directory);
      await this.assertPathTree(directory);
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      folders.add(relative(this.root, directory).split(sep).join("/") || ".");
      if (folders.size > 5000)
        throw new WorkspaceError("FOLDER_LIMIT", "More than 5,000 workspace folders; narrow readRoots");
      for (const entry of entries) {
        if (result.size >= 5000)
          throw new WorkspaceError("FILE_LIMIT", "More than 5,000 workspace files; narrow readRoots");
        if (entry.isSymbolicLink() || hidden.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (/\.(?:[cm]?ts|tsx|sql)$/u.test(entry.name)) result.add(relative(this.root, path).split(sep).join("/"));
      }
    };
    for (const root of new Set([...this.readRoots, ...this.writeRoots])) await visit(resolve(this.root, root));
    return { files: [...result].sort(), folders: [...folders].sort() };
  }
  async list(): Promise<string[]> {
    return (await this.inventory()).files;
  }
  async listFolders(): Promise<string[]> {
    return (await this.inventory()).folders;
  }
}
