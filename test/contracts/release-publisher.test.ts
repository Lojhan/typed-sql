import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { withExitedPrereleaseState } from "../../scripts/publish-prerelease.mjs";

await describe("prerelease publisher", async () => {
  await it("temporarily decouples the beta version suffix from npm's next tag", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-publish-"));
    const statePath = join(temporary, "pre.json");
    const original = '{\n  "mode": "pre",\n  "tag": "beta"\n}\n';
    await writeFile(statePath, original);
    try {
      await withExitedPrereleaseState(statePath, async () => {
        const state = JSON.parse(await readFile(statePath, "utf8")) as { mode: string; tag: string };
        strict.strictEqual(state.mode, "exit");
        strict.strictEqual(state.tag, "beta");
      });
      strict.strictEqual(await readFile(statePath, "utf8"), original);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("restores prerelease state after a failed publish", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-publish-"));
    const statePath = join(temporary, "pre.json");
    const original = '{"mode":"pre","tag":"beta"}\n';
    await writeFile(statePath, original);
    try {
      await strict.rejects(
        withExitedPrereleaseState(statePath, async () => {
          throw new Error("publish failed");
        }),
        /publish failed/u,
      );
      strict.strictEqual(await readFile(statePath, "utf8"), original);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
