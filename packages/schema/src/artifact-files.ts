import { randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Stage every file before replacing any destination. Each replacement is atomic on the
 * destination filesystem, not a transaction across files. Publish authoritative inputs last.
 */
export async function writeArtifactFiles(
  files: readonly { readonly path: string; readonly content: string }[],
): Promise<void> {
  const destinations = files.map(({ path }) => resolve(path));
  if (new Set(destinations).size !== destinations.length) throw new TypeError("Artifact destinations must be distinct");
  const staged: { path: string; temporary: string }[] = [];
  try {
    for (const [index, file] of files.entries()) {
      const path = destinations[index]!;
      await mkdir(dirname(path), { recursive: true });
      const mode = await stat(path).then(
        (value) => value.mode & 0o777,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return 0o666 & ~process.umask();
        },
      );
      const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.pending`);
      const handle = await open(temporary, "wx", 0o600);
      staged.push({ path, temporary });
      try {
        await handle.writeFile(file.content, "utf8");
        await handle.chmod(mode);
      } finally {
        await handle.close();
      }
    }
    for (const { path, temporary } of staged) await rename(temporary, path);
  } finally {
    // A successful rename already removed the staging path. Preserve the original I/O error.
    await Promise.all(staged.map(({ temporary }) => unlink(temporary).catch(() => {})));
  }
}
