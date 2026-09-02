import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";

const execute = promisify(execFile);
const workspace = process.cwd();

await describe("PostgreSQL support matrix", async () => {
  await it("pins every supported minor and keeps the next major non-blocking", async () => {
    const workflow = await readFile(join(workspace, ".github", "workflows", "ci.yml"), "utf8");
    for (const target of ["14.24", "15.19", "16.15", "17.11", "18.6", "19beta3"]) {
      strict.ok(workflow.includes(`version: ${target}`) || workflow.includes(`version: "${target}"`));
      strict.ok(workflow.includes(`postgres:${target}-bookworm`));
    }
    strict.ok(workflow.includes("continue-on-error: ${{ matrix.experimental }}"));
    strict.ok(workflow.includes("node scripts/review-postgres-matrix.mjs"));
    strict.ok(workflow.includes("merge-multiple: true"));

    const support = await readFile(join(workspace, "packages", "postgres", "src", "support.ts"), "utf8");
    strict.ok(support.includes("stableMajors: Object.freeze([14, 15, 16, 17, 18]"));
    for (const target of ["14.24", "15.19", "16.15", "17.11", "18.6", "19beta3"])
      strict.ok(support.includes(`"${target}"`));
  });

  await it("reviews the canary separately from the complete stable score", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-postgres-matrix-contract-"));
    try {
      const artifact = (major: number, version: string, channel: "stable" | "canary") => ({
        formatVersion: 1,
        target: {
          label: `postgres-${version}`,
          channel,
          actualVersion: version,
          actualMajor: major,
          driver: "pg",
        },
        evidence: {
          keywords: {
            values: major === 19 ? ["select:R", "future:U"] : ["select:R"],
          },
          catalog: {
            revision: `sha256:${String(major).padStart(64, "0")}`,
            typeCount: major,
            castCount: major,
            liveRoutineNames: major === 19 ? ["COUNT", "FUTURE"] : ["COUNT"],
          },
          syntax: [{ id: "future", accepted: major === 19 }],
        },
        results: [],
        summary: { pass: 1, fail: 0 },
      });
      for (const [major, version] of [
        [14, "14.24"],
        [15, "15.19"],
        [16, "16.15"],
        [17, "17.11"],
        [18, "18.6"],
      ] as const)
        await writeFile(join(directory, `${major}.json`), JSON.stringify(artifact(major, version, "stable")));
      await writeFile(join(directory, "19.json"), JSON.stringify(artifact(19, "19beta3", "canary")));
      const output = join(directory, "review.json");
      await execute(
        process.execPath,
        [join(workspace, "scripts", "review-postgres-matrix.mjs"), "--input", directory, "--output", output],
        { cwd: workspace },
      );
      const review = JSON.parse(await readFile(output, "utf8"));
      strict.strictEqual(review.stable.complete, true);
      strict.strictEqual(review.canary.status, "reported");
      strict.deepStrictEqual(review.canary.keywords.added, ["future:U"]);
      strict.deepStrictEqual(review.canary.catalog.routinesAdded, ["FUTURE"]);
      strict.deepStrictEqual(review.canary.syntax, [{ id: "future", baseline: false, canary: true }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
