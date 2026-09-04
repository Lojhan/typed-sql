import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { writeArtifactFiles } from "../src/index.js";

await describe("atomic artifact publication", async () => {
  await it("exposes complete old or new JSON and preserves file permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-atomic-"));
    try {
      const path = join(directory, "schema.json");
      const first = JSON.stringify({ generation: 1, value: "x".repeat(100_000) });
      const second = JSON.stringify({ generation: 2, value: "y".repeat(100_000) });
      await writeFile(path, first);
      await chmod(path, 0o600);
      const publishing = writeArtifactFiles([{ path, content: second }]);
      for (let index = 0; index < 20; index += 1) {
        const content = await readFile(path, "utf8");
        strict.ok(content === first || content === second);
        strict.ok(JSON.parse(content).generation > 0);
      }
      await publishing;
      strict.strictEqual(await readFile(path, "utf8"), second);
      if (process.platform !== "win32") strict.strictEqual((await stat(path)).mode & 0o777, 0o600);
      strict.deepStrictEqual(await readdir(directory), ["schema.json"]);
      await writeArtifactFiles([]);
      await strict.rejects(
        writeArtifactFiles([
          { path, content: first },
          { path, content: second },
        ]),
        /distinct/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("does not replace earlier files when staging fails and cleans up after rename failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-atomic-failure-"));
    try {
      const path = join(directory, "schema.json");
      await writeFile(path, "old");
      await strict.rejects(
        writeArtifactFiles([
          { path, content: "new" },
          { path: join(path, "impossible.json"), content: "new" },
        ]),
      );
      strict.strictEqual(await readFile(path, "utf8"), "old");
      const blocked = join(directory, "blocked");
      await mkdir(blocked);
      await strict.rejects(writeArtifactFiles([{ path: blocked, content: "new" }]));
      strict.deepStrictEqual((await readdir(directory)).sort(), ["blocked", "schema.json"]);
      const nested = join(directory, "nested", "new.json");
      await writeArtifactFiles([{ path: nested, content: "new" }]);
      strict.strictEqual(await readFile(nested, "utf8"), "new");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
