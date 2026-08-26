import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { assertRcSoak, validateRcSoakReport } from "../../scripts/assert-rc-soak.mjs";

const startedAt = "2026-08-01T00:00:00.000Z";
const finishedAt = "2026-08-08T00:00:00.000Z";
const candidate = "1.0.0-rc.0";
const databaseChecks = [
  "install",
  "generation",
  "typecheck",
  "runtime",
  "drift",
  "determinism",
  "driver-compatibility",
  "query-composition",
];
const editorChecks = ["install", "generation", "typecheck", "hover", "diagnostics", "quick-fix", "restart"];

function run(at: string, checks: readonly string[], suffix: string, generatedHash?: string) {
  return {
    at,
    result: "pass",
    consumerCommit: suffix.repeat(40),
    evidence: `https://github.com/Lojhan/consumer/actions/runs/${suffix}`,
    checks,
    ...(generatedHash === undefined ? {} : { generatedHash }),
  };
}

function validReport() {
  const hash = "a".repeat(64);
  return {
    schemaVersion: 1,
    series: "1.0.0",
    candidate,
    npmTag: "next",
    releaseCommit: "f".repeat(40),
    publishedAt: startedAt,
    startedAt,
    minimumDays: 7,
    consumers: [
      {
        id: "postgres-app",
        role: "postgres",
        repository: "https://github.com/Lojhan/postgres-consumer",
        installSource: "registry",
        node: "24.10.0",
        packageManager: "pnpm@10.32.1",
        typescript: { name: "typescript", version: "7.0.2" },
        database: { name: "postgresql", version: "18.0.0" },
        driver: { name: "pg", version: "8.23.0" },
        packages: {
          "@typed-sql/core": candidate,
          "@typed-sql/postgres": candidate,
          "@typed-sql/cli": candidate,
        },
        runs: [run(startedAt, databaseChecks, "1", hash), run(finishedAt, databaseChecks, "2", hash)],
      },
      {
        id: "mysql-app",
        role: "mysql",
        repository: "https://github.com/Lojhan/mysql-consumer",
        installSource: "registry",
        node: "22.14.0",
        packageManager: "pnpm@10.32.1",
        typescript: { name: "typescript", version: "7.1.0-dev.20260825" },
        database: { name: "mysql", version: "9.4.0" },
        driver: { name: "mysql2", version: "3.24.1" },
        packages: {
          "@typed-sql/core": candidate,
          "@typed-sql/mysql": candidate,
          "@typed-sql/cli": candidate,
        },
        runs: [run(startedAt, databaseChecks, "3", hash), run(finishedAt, databaseChecks, "4", hash)],
      },
      {
        id: "zed-app",
        role: "editor",
        repository: "https://github.com/Lojhan/editor-consumer",
        installSource: "registry",
        node: "24.10.0",
        packageManager: "pnpm@10.32.1",
        typescript: { name: "typescript", version: "7.0.2" },
        editor: { name: "zed", version: "0.202.5" },
        packages: {
          "@typed-sql/language-server": candidate,
          "@typed-sql/ts-bridge": candidate,
        },
        runs: [run(startedAt, editorChecks, "5"), run(finishedAt, editorChecks, "6")],
      },
    ],
    blockers: [
      {
        id: "typed-sql#29",
        category: "false-acceptance",
        status: "resolved",
        resolvedAt: "2026-08-02T00:00:00.000Z",
        regressionTest: "https://github.com/Lojhan/typed-sql/blob/abcdef/test.ts",
      },
    ],
    decision: {
      outcome: "go",
      decidedAt: finishedAt,
      owner: "Lojhan",
      rationale: "All consumers passed for seven full days.",
      knownLimitations: ["Editor tooling remains experimental."],
    },
  };
}

const validationOptions = { series: "1.0.0", now: new Date("2026-08-09T00:00:00.000Z") };

await describe("release-candidate soak policy", async () => {
  await it("accepts complete evidence from three independent consumers", () => {
    strict.deepStrictEqual(validateRcSoakReport(validReport(), validationOptions), {
      candidate,
      releaseCommit: "f".repeat(40),
      minimumDays: 7,
      consumerCount: 3,
      blockerCount: 1,
      decision: "go",
    });
  });

  await it("rejects an incomplete soak window", () => {
    strict.throws(
      () => validateRcSoakReport(validReport(), { series: "1.0.0", now: new Date("2026-08-07T00:00:00.000Z") }),
      /has not completed/u,
    );
  });

  await it("rejects non-independent consumers and incomplete checks", () => {
    const duplicate = validReport();
    duplicate.consumers[1]!.repository = duplicate.consumers[0]!.repository;
    strict.throws(() => validateRcSoakReport(duplicate, validationOptions), /distinct external repositories/u);

    const workspaceLinked = validReport();
    workspaceLinked.consumers[0]!.installSource = "workspace";
    strict.throws(() => validateRcSoakReport(workspaceLinked, validationOptions), /installSource must be registry/u);

    const incomplete = validReport();
    incomplete.consumers[0]!.runs[0]!.checks = databaseChecks.filter((check) => check !== "query-composition");
    strict.throws(() => validateRcSoakReport(incomplete, validationOptions), /missing query-composition/u);
  });

  await it("rejects generated drift, incorrect pins, and unresolved blockers", () => {
    const drifted = validReport();
    drifted.consumers[0]!.runs[1]!.generatedHash = "b".repeat(64);
    strict.throws(() => validateRcSoakReport(drifted, validationOptions), /generated output changed/u);

    const wrongVersion = validReport();
    wrongVersion.consumers[1]!.packages["@typed-sql/mysql"] = "1.0.0-rc.1";
    strict.throws(() => validateRcSoakReport(wrongVersion, validationOptions), /must pin @typed-sql\/mysql/u);

    const blocked = validReport();
    blocked.blockers[0]!.status = "open";
    strict.throws(() => validateRcSoakReport(blocked, validationOptions), /remains unresolved/u);
  });

  await it("requires an explicit post-soak go decision", () => {
    const undecided = validReport();
    undecided.decision.outcome = "no-go";
    strict.throws(() => validateRcSoakReport(undecided, validationOptions), /decision must be go/u);
  });

  await it("ties stable publication to the exact rehearsed RC", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-rc-soak-"));
    try {
      await writeFile(
        join(temporary, "release-manifest.json"),
        JSON.stringify({
          channel: "stable",
          series: "1.0.0",
          npmTag: "latest",
          sourceCandidate: "1.0.0-rc.1",
          packages: ["@typed-sql/core"],
          packagePolicy: { stable: ["@typed-sql/core"], experimental: [] },
        }),
      );
      const reportPath = join(temporary, "soak.json");
      await writeFile(reportPath, JSON.stringify(validReport()));
      await strict.rejects(
        assertRcSoak({ workspace: temporary, reportPath, now: validationOptions.now }),
        /rehearsed from 1\.0\.0-rc\.1, but soak covers 1\.0\.0-rc\.0/u,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
