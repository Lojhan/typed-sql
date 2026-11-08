import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WorkspaceError } from "./files.js";
export async function privateRead(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
      throw new WorkspaceError("AGENT_STORAGE", "Agent storage is not an ordinary bounded file");
    if ((stat.mode & 0o077) !== 0 && process.platform !== "win32") await handle.chmod(0o600);
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, 8 * 1024 * 1024 + 1 - size));
      const { bytesRead } = await handle.read(chunk);
      if (bytesRead === 0) return Buffer.concat(chunks).toString("utf8");
      size += bytesRead;
      if (size > 8 * 1024 * 1024) throw new WorkspaceError("AGENT_STORAGE", "Agent storage exceeds 8 MiB");
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}
export async function privateWrite(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  if ((await lstat(dirname(file))).isSymbolicLink())
    throw new WorkspaceError("AGENT_STORAGE", "Agent storage must not use a symlink directory");
  await chmod(dirname(file), 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const source = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(source) > 8 * 1024 * 1024)
      throw new WorkspaceError("AGENT_STORAGE", "Agent storage exceeds 8 MiB; archive conversations before continuing");
    await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
