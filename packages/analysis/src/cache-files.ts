import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export const cacheDigestPattern = /^[a-f0-9]{64}$/u;
export const cacheTemporaryPattern = /^[a-f0-9-]{36}\.tmp$/u;
export function cacheMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
export async function cacheDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("Unsafe analysis cache directory");
}
export async function readCacheFile(path: string, limit: number, label = "Analysis cache"): Promise<string> {
  const expected = await lstat(path);
  if (!expected.isFile() || expected.isSymbolicLink()) throw new TypeError(`${label} objects must be regular files`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.ino !== expected.ino || stat.dev !== expected.dev)
      throw new TypeError(`${label} file changed while opening`);
    if (stat.size > limit) throw new TypeError(`${label} object exceeds byte limit`);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new TypeError(`${label} object exceeds byte limit`);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    await file.close();
  }
}
export async function writeCacheFile(input: {
  path: string;
  staging: string;
  text: string;
  limit: number;
  immutable: boolean;
  assertLock(): Promise<void>;
}): Promise<void> {
  if (Buffer.byteLength(input.text) > input.limit) throw new TypeError("Analysis cache object exceeds byte limit");
  await cacheDirectory(dirname(input.path));
  const temporary = join(input.staging, `${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(input.text);
      await file.sync();
    } finally {
      await file.close();
    }
    await input.assertLock();
    if (!input.immutable) await rename(temporary, input.path);
    else {
      try {
        await link(temporary, input.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await readCacheFile(input.path, input.limit)) !== input.text)
          throw new TypeError("Conflicting immutable analysis cache object");
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (!cacheMissing(error)) throw error;
    });
  }
}
