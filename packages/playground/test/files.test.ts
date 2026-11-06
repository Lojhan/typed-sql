import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { contentHash, WorkspaceFiles } from "../src/files.js";

const root = await mkdtemp(join(tmpdir(), "typed-sql-workspace-files-"));
const outside = await mkdtemp(join(tmpdir(), "typed-sql-workspace-outside-"));
const files = new WorkspaceFiles(root, ["src", "playground"], ["playground"]);
try {
  await describe("project workspace filesystem", async () => {
    await it("serializes simultaneous updates against one revision without losing an edit", async () => {
      const initial = await files.save("playground/query.ts", "export const value = 1;", null);
      const results = await Promise.allSettled([
        files.save("playground/query.ts", "export const value = 2;", initial.revision),
        files.save("playground/query.ts", "export const value = 3;", initial.revision),
      ]);
      strict.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const failure = results.find((result) => result.status === "rejected");
      strict.ok(failure?.status === "rejected" && failure.reason.code === "FILE_CONFLICT");
      strict.equal(
        (await files.read("playground/query.ts")).source,
        results[0]?.status === "fulfilled" ? "export const value = 2;" : "export const value = 3;",
      );
    });

    await it("atomically refuses concurrent creation instead of replacing another file", async () => {
      const results = await Promise.allSettled([
        files.save("playground/new.sql", "select 1", null),
        files.save("playground/new.sql", "select 2", null),
      ]);
      strict.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      strict.equal(
        (await files.read("playground/new.sql")).source,
        results[0]?.status === "fulfilled" ? "select 1" : "select 2",
      );
    });

    await it("detects outside edits and confines write roots", async () => {
      const previous = await files.read("playground/query.ts");
      await writeFile(join(root, "playground/query.ts"), "// edited externally");
      await strict.rejects(
        () => files.save("playground/query.ts", "// overwrite", previous.revision),
        /changed on disk/,
      );
      strict.equal(await readFile(join(root, "playground/query.ts"), "utf8"), "// edited externally");
      await strict.rejects(() => files.save("src/query.ts", "select 1", null), /outside/);
      await strict.rejects(() => files.read("../secret.ts"), /project-relative/);
      await strict.rejects(() => files.save("playground/.git/hidden.ts", "", null), /project-relative/);
    });

    await it("moves verified files without overwriting an existing destination", async () => {
      const source = await files.save("playground/move.ts", "export const x = 1", null);
      const moved = await files.move("playground/move.ts", "playground/nested/moved.ts", source.revision);
      strict.equal((await files.read(moved.file)).source, "export const x = 1");
      await strict.rejects(() => files.read("playground/move.ts"));
      await strict.rejects(() => files.move(moved.file, "playground/new.sql", moved.revision), /changed on disk/);
      strict.equal((await files.read(moved.file)).revision, moved.revision);
    });

    await it("rejects symlink files and roots, including file-tree traversal", async () => {
      await writeFile(join(outside, "secret.ts"), "export const secret = 1;");
      await symlink(join(outside, "secret.ts"), join(root, "playground/linked.ts"));
      await strict.rejects(() => files.read("playground/linked.ts"), /Symlinks/);
      await strict.rejects(
        () => files.save("playground/linked.ts", "overwrite", contentHash("export const secret = 1;")),
        /Symlinks/,
      );
      await symlink(outside, join(root, "linked"));
      const linked = new WorkspaceFiles(root, ["linked"], ["playground"]);
      await strict.rejects(() => linked.list(), /Symlinks/);
      strict.equal(await readFile(join(outside, "secret.ts"), "utf8"), "export const secret = 1;");
    });

    await it("lists ordinary permitted files and enforces the read size limit", async () => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/read-only.ts"), "export const readOnly = true");
      const listing = await files.list();
      strict.ok(listing.includes("src/read-only.ts"));
      strict.ok(!listing.includes("playground/linked.ts"));
      await writeFile(join(root, "playground/large.ts"), "x".repeat(512 * 1024 + 1));
      await strict.rejects(() => files.read("playground/large.ts"), /512 KiB/);
    });
  });
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
