import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, strict } from "poku";

const workspace = resolve(import.meta.dirname, "../..");

await describe("CI evidence lanes", async () => {
  await it("keeps pull-request work bounded and comprehensive matrices scheduled", async () => {
    const workflow = await readFile(join(workspace, ".github/workflows/ci.yml"), "utf8");
    strict.ok(workflow.includes('cron: "17 4 * * 2"'));
    for (const job of [
      "typescript-editor-matrix",
      "postgres-e2e",
      "mysql-e2e",
      "examples-e2e",
      "sqlite-node-matrix",
      "sqlite-language-matrix",
    ]) {
      const section = workflow.slice(workflow.indexOf(`  ${job}:`));
      strict.ok(
        section.startsWith(`  ${job}:\n    if: github.event_name != 'pull_request'`),
        `${job} is not scheduled-only`,
      );
    }
    for (const evidence of [
      "pull-request-distribution:",
      "pnpm api:check",
      "pnpm test:pack",
      "pnpm docs:check",
      "scheduled-reliability:",
      "pnpm fuzz:replay",
      "pnpm mutation:pilot",
      "retention-days: 30",
    ]) {
      strict.ok(workflow.includes(evidence), `CI lane lost ${evidence}`);
    }
  });

  await it("requires representative live database and packaged editor checks before protected quality", async () => {
    const workflow = await readFile(join(workspace, ".github/workflows/ci.yml"), "utf8");
    for (const job of ["packed-real-databases", "editor-artifacts"]) {
      const start = workflow.indexOf(`  ${job}:\n`);
      strict.ok(start >= 0);
      const section = workflow.slice(start).split(/\n(?= {2}\S)/u)[0]!;
      strict.ok(!/^ {4}if:/mu.test(section), `${job} must not exclude pull requests`);
    }
    strict.ok(workflow.includes("needs: [packed-real-databases, editor-artifacts]"));
    strict.ok(workflow.includes("pnpm e2e:packed"));
    strict.ok(workflow.includes("pnpm editor:artifacts:smoke"));
  });

  await it("writes only structured identifiers and environment-owned run metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-ci-evidence-"));
    try {
      const path = join(directory, "nested", "evidence.json");
      const script = join(workspace, "scripts/write-ci-evidence.mjs");
      const environment = {
        ...process.env,
        TYPED_SQL_MATRIX_TARGET: "test-target",
        GITHUB_SHA: "test-revision",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        DATABASE_URL: "secret-database-url",
        PGPASSWORD: "secret-postgres-password",
        MYSQL_PWD: "secret-mysql-password",
        TOKEN: "secret-token",
      };
      execFileSync(
        process.execPath,
        [
          script,
          "--lane",
          "pull-request",
          "--output",
          path,
          "--gate",
          "packed-consumer",
          "--gate",
          "api",
          "--gate",
          "api",
        ],
        { env: environment },
      );
      const content = await readFile(path, "utf8");
      strict.deepStrictEqual(JSON.parse(content), {
        formatVersion: 1,
        lane: "pull-request",
        target: "test-target",
        revision: "test-revision",
        run: "123",
        attempt: "2",
        gates: ["api", "packed-consumer"],
      });
      strict.ok(!content.includes("secret-"));
      for (const args of [
        [],
        ["--lane", "INVALID", "--output", path, "--gate", "api"],
        ["--lane", "pull-request", "--output", path, "--gate", "INVALID"],
      ]) {
        strict.throws(() => execFileSync(process.execPath, [script, ...args], { env: environment, stdio: "pipe" }));
        strict.strictEqual(await readFile(path, "utf8"), content, "invalid requests cannot overwrite valid evidence");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("prepares clean-checkout runtime lanes before executing package entrypoints", async () => {
    const workflow = await readFile(join(workspace, ".github/workflows/ci.yml"), "utf8");
    const packed = workflow.slice(workflow.indexOf("  packed-real-databases:"), workflow.indexOf("  examples-e2e:"));
    const sqlite = workflow.slice(
      workflow.indexOf("  sqlite-node-matrix:"),
      workflow.indexOf("  sqlite-language-matrix:"),
    );
    const editor = workflow.slice(
      workflow.indexOf("  editor-artifacts:"),
      workflow.indexOf("  pull-request-distribution:"),
    );

    strict.ok(packed.includes("node-version: 22.13"), "packed SQLite acceptance must use its minimum Node version");
    strict.ok(sqlite.includes("pnpm typecheck\n      - run: pnpm --filter @typed-sql/sqlite test"));
    strict.ok(
      editor.includes(
        "pnpm exec poku packages/language-server/test/language-server.test.ts --reporter=compact --enforce",
      ),
      "editor artifact tests must resolve the workspace-local Poku executable",
    );
  });
});
