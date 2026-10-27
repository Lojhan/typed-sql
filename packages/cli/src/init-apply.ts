import { realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { lock } from "proper-lockfile";
import {
  assertInitFile,
  assertInitProjectPath,
  checkInitPath,
  initHash,
  readInitFile,
  syncInitDirectory,
  writeInitFile,
} from "./init-files.js";
import type { InitPlan } from "./init-plan.js";

interface JournalFile {
  readonly path: string;
  readonly before: string | null;
  readonly beforeMode: number | null;
  readonly after: string;
  readonly afterMode: number;
}
interface Journal {
  readonly formatVersion: 1;
  readonly root: string;
  readonly status: "applying" | "completed" | "rolled-back";
  readonly files: readonly JournalFile[];
}

async function withInitLock<T>(root: string, run: (journal: string, assertLock: () => void) => Promise<T>): Promise<T> {
  const journal = join(root, ".typed-sql", "init-journal.json");
  await checkInitPath(root, journal, true);
  // The lock directory is library-owned; reject symlinks before entering the lock protocol.
  const lockPath = join(root, ".typed-sql", "init.lock");
  await checkInitPath(root, join(lockPath, "owner"));
  let compromised: Error | undefined;
  const release = await lock(root, {
    realpath: false,
    lockfilePath: lockPath,
    stale: 10_000,
    update: 2_000,
    retries: 0,
    onCompromised: (error) => {
      compromised = error;
    },
  });
  const assertLock = () => {
    if (compromised !== undefined)
      throw new Error("Setup lock was lost; preserve the journal and recover before retrying", { cause: compromised });
  };
  try {
    return await run(journal, assertLock);
  } finally {
    await release();
  }
}

function parseJournal(text: string, root: string): Journal {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) throw new Error("Invalid setup journal");
  const candidate = value as Partial<Journal>;
  if (
    candidate.formatVersion !== 1 ||
    candidate.root !== root ||
    !["applying", "completed", "rolled-back"].includes(candidate.status ?? "") ||
    !Array.isArray(candidate.files) ||
    candidate.files.length > 32
  )
    throw new Error("Invalid setup journal; preserve it for manual recovery");
  const paths = new Set<string>();
  for (const file of candidate.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      (file.before !== null && typeof file.before !== "string") ||
      typeof file.after !== "string" ||
      (file.beforeMode !== null &&
        (!Number.isInteger(file.beforeMode) || file.beforeMode < 0 || file.beforeMode > 0o777)) ||
      !Number.isInteger(file.afterMode) ||
      file.afterMode < 0 ||
      file.afterMode > 0o777 ||
      paths.has(file.path)
    )
      throw new Error("Invalid setup journal file; preserve it for manual recovery");
    assertInitProjectPath(root, file.path);
    paths.add(file.path);
  }
  return candidate as Journal;
}

async function rollback(
  root: string,
  path: string,
  text: string,
  journal: Journal,
  assertLock: () => void,
): Promise<string[]> {
  const conflicts: string[] = [];
  const restored: string[] = [];
  for (const file of [...journal.files].reverse()) {
    assertLock();
    await checkInitPath(root, file.path);
    const current = await readInitFile(file.path);
    if ((current?.text ?? null) === file.before && (current?.mode ?? null) === file.beforeMode) continue;
    if (current?.text !== file.after || current.mode !== file.afterMode) {
      conflicts.push(file.path);
      continue;
    }
    if (file.before === null) {
      await assertInitFile(root, file.path, initHash(file.after));
      await unlink(file.path);
      await syncInitDirectory(dirname(file.path));
    } else await writeInitFile(root, file.path, file.before, initHash(file.after), file.beforeMode ?? undefined);
    restored.push(file.path);
  }
  if (conflicts.length > 0)
    throw new Error(
      `Recovery preserved concurrent edits in: ${conflicts.join(", ")}. Keep ${path} until these files are reconciled.`,
    );
  assertLock();
  await writeInitFile(
    root,
    path,
    `${JSON.stringify({ ...journal, status: "rolled-back" }, null, 2)}\n`,
    initHash(text),
    0o600,
  );
  return restored;
}

export async function applyInitPlan(
  plan: InitPlan,
): Promise<{ state: "config-written"; files: readonly string[]; journal: string }> {
  const root = await realpath(plan.root);
  if (root !== plan.root || plan.files.length > 32) throw new Error("Invalid setup plan root or file limit");
  return withInitLock(root, async (journalPath, assertLock) => {
    const previousJournal = await readInitFile(journalPath);
    if (previousJournal !== undefined && parseJournal(previousJournal.text, root).status === "applying")
      throw new Error(
        "An interrupted setup needs recovery; run typed-sql init --recover with this application's --cwd",
      );
    const files: JournalFile[] = [];
    const seen = new Set<string>();
    for (const file of plan.files) {
      assertInitProjectPath(root, file.path);
      if (
        seen.has(file.path) ||
        [...seen].some((path) => path.startsWith(`${file.path}${sep}`) || file.path.startsWith(`${path}${sep}`))
      )
        throw new Error("Duplicate or overlapping setup plan path");
      seen.add(file.path);
      const before = await assertInitFile(root, file.path, file.beforeHash);
      files.push({
        path: file.path,
        before: before?.text ?? null,
        beforeMode: before?.mode ?? null,
        after: file.content,
        afterMode: before?.mode ?? 0o666 & ~process.umask(),
      });
    }
    if (files.length === 0) return { state: "config-written", files: [], journal: journalPath };
    const journal: Journal = { formatVersion: 1, root, status: "applying", files };
    const text = `${JSON.stringify(journal, null, 2)}\n`;
    if (Buffer.byteLength(text) > 16 * 1024 * 1024)
      throw new Error("Setup journal exceeds 16 MiB; split the setup into smaller changes");
    assertLock();
    await writeInitFile(
      root,
      journalPath,
      text,
      previousJournal === undefined ? null : initHash(previousJournal.text),
      0o600,
    );
    try {
      for (const file of files) {
        assertLock();
        await writeInitFile(root, file.path, file.after, file.before === null ? null : initHash(file.before));
      }
      assertLock();
      await writeInitFile(
        root,
        journalPath,
        `${JSON.stringify({ ...journal, status: "completed" }, null, 2)}\n`,
        initHash(text),
        0o600,
      );
    } catch (error) {
      assertLock();
      await rollback(root, journalPath, text, journal, assertLock);
      throw new Error("Setup failed and its file changes were rolled back", { cause: error });
    }
    return { state: "config-written", files: files.map((file) => file.path), journal: journalPath };
  });
}

export async function recoverInit(rootDirectory: string): Promise<{ state: "recovered"; files: readonly string[] }> {
  const root = await realpath(resolve(rootDirectory));
  return withInitLock(root, async (path, assertLock) => {
    const current = await readInitFile(path);
    if (current === undefined) return { state: "recovered", files: [] };
    const journal = parseJournal(current.text, root);
    if (journal.status !== "applying") return { state: "recovered", files: [] };
    return { state: "recovered", files: await rollback(root, path, current.text, journal, assertLock) };
  });
}
