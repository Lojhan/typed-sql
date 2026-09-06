import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TYPESCRIPT_COMPILER_SUPPORT_POLICY } from "@typed-sql/compiler";
import { describe, it, strict } from "poku";
import { planInit } from "../src/init-plan.js";

async function fixture(run: (root: string, boundary: string) => Promise<void>) {
  const boundary = await mkdtemp(join(tmpdir(), "typed-sql-init-"));
  const root = join(boundary, "app");
  try {
    await mkdir(root);
    await writeFile(join(boundary, "package.json"), JSON.stringify({ workspaces: ["app"] }));
    await run(root, boundary);
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
}

await describe("nonexecuting init planner", async () => {
  await it("is deterministic, never writes, and does not invent a schema", async () => {
    await fixture(async (root) => {
      for (const grammar of ["postgres", "mysql", "sqlite"]) {
        const plan = await planInit({ cwd: root, grammar, editor: "vscode", "dry-run": "true" }, "2.1.0");
        strict.deepEqual(await planInit({ cwd: root, grammar, editor: "vscode", "dry-run": "true" }, "2.1.0"), plan);
        strict.equal(plan.packageManager, "npm");
        strict.equal(plan.files.length, 3);
        strict.ok(plan.files.every((file) => file.beforeHash === null && file.path.startsWith(`${root}/`)));
        strict.ok(!plan.files.some((file) => file.path.endsWith("schema.json")));
        strict.equal(plan.dependencies[`@typed-sql/${grammar}`], "^2.1.0");
        strict.equal(plan.dependencies.typescript, TYPESCRIPT_COMPILER_SUPPORT_POLICY.exactVersion);
        strict.ok(plan.pending.some((item) => item.includes("separate approval")));
        strict.deepEqual(await readdir(root), []);
      }
    });
  });

  await it("preserves existing files and never imports executable config", async () => {
    await fixture(async (root) => {
      const manifest = '{"dependencies":{"@typed-sql/postgres":"workspace:*"},"scripts":{"check":"custom"}}';
      await writeFile(join(root, "package.json"), manifest);
      await writeFile(join(root, "typed-sql.config.ts"), 'throw new Error("must not execute");');
      await writeFile(join(root, "tsconfig.json"), '{ // preserved JSONC\n "extends":"./base.json" }');
      const plan = await planInit({ cwd: root, grammar: "postgres" }, "2.1.0");
      strict.equal(plan.files.length, 0);
      strict.equal(plan.dependencies["@typed-sql/postgres"], undefined);
      strict.equal(await readFile(join(root, "package.json"), "utf8"), manifest);
      strict.match(plan.warnings.join(" "), /not executed/u);
      const cli = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");
      const result = await promisify(execFile)(
        process.execPath,
        ["--import", fileURLToPath(import.meta.resolve("tsx")), cli, "init", "--grammar", "postgres", "--dry-run"],
        { cwd: root },
      );
      strict.equal(JSON.parse(result.stdout).mode, "plan");
      strict.equal(result.stderr, "");
      await strict.rejects(
        promisify(execFile)(
          process.execPath,
          ["--import", fileURLToPath(import.meta.resolve("tsx")), cli, "generate", "--dry-run"],
          { cwd: root },
        ),
        /--dry-run is only supported by init/u,
      );
    });
  });

  await it("requires workspace selection and rejects manager conflicts", async () => {
    await fixture(async (root, boundary) => {
      await strict.rejects(planInit({ cwd: boundary, grammar: "sqlite" }, "2.1.0"), /--package/u);
      await writeFile(join(boundary, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
      strict.equal(
        (await planInit({ cwd: boundary, package: "app", grammar: "sqlite" }, "2.1.0")).packageManager,
        "pnpm",
      );
      await writeFile(join(root, "package-lock.json"), "{}");
      await strict.rejects(planInit({ cwd: root, grammar: "sqlite" }, "2.1.0"), /Conflicting package managers/u);
    });
  });

  await it("fails closed for unsafe selections, malformed inputs and ambiguous configs", async () => {
    await fixture(async (root, boundary) => {
      for (const options of [
        {},
        { grammar: "unknown" },
        { grammar: "postgres", yes: "true" },
        { grammar: "mysql", "dry-run": "false" },
        { grammar: "sqlite", editor: "vim" },
        { grammar: "postgres", package: "../escape" },
      ])
        await strict.rejects(planInit({ cwd: root, ...options }, "2.1.0"));
      await symlink(root, join(boundary, "linked"));
      await strict.rejects(planInit({ cwd: boundary, package: "linked", grammar: "postgres" }, "2.1.0"), /symlinks/u);
      await writeFile(join(root, "package.json"), "null");
      await strict.rejects(planInit({ cwd: root, grammar: "postgres" }, "2.1.0"), /must be an object/u);
      await writeFile(join(root, "package.json"), "{}");
      await writeFile(join(root, "typed-sql.config.ts"), "");
      await writeFile(join(root, "typed-sql.config.mjs"), "");
      await strict.rejects(planInit({ cwd: root, grammar: "postgres" }, "2.1.0"), /Multiple typed-sql configurations/u);
    });
  });
});
