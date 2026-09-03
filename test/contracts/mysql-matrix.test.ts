import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";

const execute = promisify(execFile);
const workspace = process.cwd();

await describe("MySQL support matrix", async () => {
  await it("runs every LTS mode profile and keeps the innovation line non-blocking", async () => {
    const workflow = await readFile(join(workspace, ".github", "workflows", "ci.yml"), "utf8");
    for (const version of ["8.4.12", "9.7.3", "26.7.1"])
      strict.ok(workflow.includes(`docker.io/library/mysql:${version}`), `workflow is missing MySQL ${version}`);
    for (const label of [
      "mysql-8.4.12-default",
      "mysql-8.4.12-lexical",
      "mysql-8.4.12-numeric",
      "mysql-9.7.3-default",
      "mysql-9.7.3-lexical",
      "mysql-9.7.3-numeric",
      "mysql-26.7.1-canary",
    ])
      strict.ok(workflow.includes(label), `workflow is missing ${label}`);
    for (const mode of [
      "ANSI_QUOTES",
      "IGNORE_SPACE",
      "NO_BACKSLASH_ESCAPES",
      "PIPES_AS_CONCAT",
      "NO_UNSIGNED_SUBTRACTION",
    ])
      strict.ok(workflow.includes(mode), `workflow is missing ${mode}`);
    strict.ok(workflow.includes("continue-on-error: ${{ matrix.experimental }}"));
    strict.ok(workflow.includes("node scripts/review-mysql-matrix.mjs"));
    strict.ok(workflow.includes("merge-multiple: true"));

    const container = await readFile(join(workspace, "e2e", "mysql", "Containerfile"), "utf8");
    strict.ok(container.includes("ARG MYSQL_BASE_IMAGE="));
    strict.ok(container.includes("FROM ${MYSQL_BASE_IMAGE}"));

    const support = await readFile(join(workspace, "packages", "mysql", "src", "support.ts"), "utf8");
    for (const version of ["8.4.12", "9.7.3", "26.7.1"]) strict.ok(support.includes(`matrixVersion: "${version}"`));
  });

  await it("publishes the stable boundary, mode profiles, and separate canary score", async () => {
    const dialect = await readFile(join(workspace, "docs", "dialects", "mysql.md"), "utf8");
    const compatibility = await readFile(join(workspace, "docs", "reference", "compatibility.md"), "utf8");
    const verification = await readFile(join(workspace, "docs", "guides", "live-verification.md"), "utf8");
    const readme = await readFile(join(workspace, "packages", "mysql", "README.md"), "utf8");
    for (const version of ["8.4.12", "9.7.3", "26.7.1"]) {
      strict.ok(dialect.includes(version), `MySQL guide is missing ${version}`);
      strict.ok(compatibility.includes(version), `compatibility reference is missing ${version}`);
      strict.ok(verification.includes(version), `live verification guide is missing ${version}`);
      strict.ok(readme.includes(version), `package README is missing ${version}`);
    }
    for (const contract of [
      "ANSI_QUOTES",
      "NO_BACKSLASH_ESCAPES",
      "PIPES_AS_CONCAT",
      "NO_UNSIGNED_SUBTRACTION",
      "release-blocking",
      "does not contribute to the stable score",
    ])
      strict.ok(dialect.includes(contract), `MySQL guide is missing ${contract}`);
  });

  await it("requires six stable targets and reports canary deltas independently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-mysql-matrix-contract-"));
    try {
      const artifact = (series: string, version: string, modeProfile: string, channel: "stable" | "canary") => ({
        formatVersion: 1,
        target: {
          label: `mysql-${version}-${modeProfile}`,
          channel,
          modeProfile,
          actualVersion: version,
          actualSeries: series,
          driver: "mysql2",
        },
        evidence: {
          keywords: { values: channel === "canary" ? ["select:1", "future:0"] : ["select:1"] },
          collations: {
            values:
              channel === "canary" ? ["utf8mb4_0900_ai_ci:utf8mb4", "future:utf8mb4"] : ["utf8mb4_0900_ai_ci:utf8mb4"],
          },
          catalog: {
            revision: `sha256:${series.replace(".", "").padStart(64, "0")}`,
            typeCount: channel === "canary" ? 3 : 2,
            coercionCount: channel === "canary" ? 5 : 4,
            routineCount: channel === "canary" ? 7 : 6,
          },
          syntax: [{ id: "future", accepted: channel === "canary" }],
        },
        results: [],
        summary: { pass: 1, fail: 0 },
      });
      for (const [series, version] of [
        ["8.4", "8.4.12"],
        ["9.7", "9.7.3"],
      ] as const)
        for (const profile of ["default", "lexical", "numeric"])
          await writeFile(
            join(directory, `${series}-${profile}.json`),
            JSON.stringify(artifact(series, version, profile, "stable")),
          );
      await writeFile(join(directory, "canary.json"), JSON.stringify(artifact("26.7", "26.7.1", "default", "canary")));

      const output = join(directory, "review.json");
      await execute(
        process.execPath,
        [join(workspace, "scripts", "review-mysql-matrix.mjs"), "--input", directory, "--output", output],
        { cwd: workspace },
      );
      const review = JSON.parse(await readFile(output, "utf8"));
      strict.strictEqual(review.stable.complete, true);
      strict.strictEqual(review.stable.observed.length, 6);
      strict.strictEqual(review.canary.status, "reported");
      strict.deepStrictEqual(review.canary.keywords.added, ["future:0"]);
      strict.deepStrictEqual(review.canary.collations.added, ["future:utf8mb4"]);
      strict.strictEqual(review.canary.catalog.typeCountDelta, 1);
      strict.deepStrictEqual(review.canary.syntax, [{ id: "future", baseline: false, canary: true }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
