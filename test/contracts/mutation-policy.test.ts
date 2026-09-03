import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it, strict } from "poku";

interface MutationBaseline {
  readonly formatVersion: number;
  readonly minimumKillRatio: number;
  readonly mutants: readonly {
    readonly id: string;
    readonly file: string;
    readonly search: string;
    readonly replacement: string;
    readonly occurrence?: number;
    readonly test: string;
  }[];
}

const workspace = resolve(import.meta.dirname, "../..");
const baseline = JSON.parse(await readFile(join(workspace, "mutation-baseline.json"), "utf8")) as MutationBaseline;

await describe("soundness mutation pilot policy", async () => {
  await it("retains unique, reviewable mutants with live source anchors", async () => {
    strict.strictEqual(baseline.formatVersion, 1);
    strict.ok(baseline.minimumKillRatio > 0 && baseline.minimumKillRatio <= 1);
    strict.strictEqual(new Set(baseline.mutants.map(({ id }) => id)).size, baseline.mutants.length);
    for (const mutant of baseline.mutants) {
      strict.ok(mutant.file.startsWith("packages/") && mutant.test.endsWith(".test.ts"));
      strict.notStrictEqual(mutant.search, mutant.replacement);
      const source = await readFile(join(workspace, mutant.file), "utf8");
      strict.ok(source.includes(mutant.search), `${mutant.id} source anchor drifted`);
    }
  });
});
