import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { lock } from "proper-lockfile";
import { runInit } from "../src/init.js";
import { applyInitPlan, recoverInit } from "../src/init-apply.js";
import { installInitDependencies } from "../src/init-install.js";
import { initJson } from "../src/init-json.js";
import { planInit } from "../src/init-plan.js";
import { verifyInitServer } from "../src/init-verify.js";

async function fixture(run: (root: string, boundary: string) => Promise<void>) {
  const boundary = await realpath(await mkdtemp(join(tmpdir(), "typed-sql-apply-")));
  const root = join(boundary, "app");
  try {
    await mkdir(root);
    await writeFile(join(boundary, "package.json"), JSON.stringify({ workspaces: ["app"] }));
    await run(root, boundary);
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
}

await describe("explicit setup application and recovery", async () => {
  await it("installs with lifecycle scripts disabled unless explicitly authorized", async () => {
    await fixture(async (root) => {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "safe-install-fixture",
          private: true,
          scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('script-ran', 'yes')\"" },
        }),
      );
      const plan = await planInit({ cwd: root, grammar: "sqlite", "package-manager": "npm" }, "2.1.0");
      await installInitDependencies(plan, false);
      await strict.rejects(stat(join(root, "script-ran")), { code: "ENOENT" });
      await installInitDependencies(plan, true);
      strict.equal(await readFile(join(root, "script-ran"), "utf8"), "yes");
    });
  });

  await it("verifies the installed beta server without claiming editor-host evidence", async () => {
    await fixture(async (root) => {
      const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      await mkdir(join(root, "node_modules/@typed-sql"), { recursive: true });
      for (const name of ["language-server", "postgres"])
        await symlink(join(workspace, "packages", name), join(root, "node_modules/@typed-sql", name), "junction");
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      await writeFile(
        join(root, "tsconfig.json"),
        '{"compilerOptions":{"module":"NodeNext"},"include":["src/**/*.ts"]}',
      );
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src/example.ts"), "export const ordinary = 1;\n");
      await writeFile(
        join(root, "typed-sql.config.ts"),
        `import { postgres } from "@typed-sql/postgres";\nexport default { dialect: postgres(), schema: { file: ${JSON.stringify(join(workspace, "test/fixtures/success/schema.json"))} }, outDir: "generated", projects: ["tsconfig.json"] };\n`,
      );
      await verifyInitServer(root);
    });
  });

  await it("preserves JSONC comments and user settings, adds dependencies, and is idempotent", async () => {
    await fixture(async (root) => {
      await mkdir(join(root, ".vscode"));
      await writeFile(
        join(root, "package.json"),
        '{"scripts":{"check":"custom"},"dependencies":{"@typed-sql/postgres":"workspace:*"}}\n',
        { mode: 0o600 },
      );
      await writeFile(
        join(root, ".vscode/settings.json"),
        '{\n // my theme\n "workbench.colorTheme": "Quiet",\n "typedSql.providerMode": "proxy",\n}\n',
      );
      await writeFile(
        join(root, ".vscode/extensions.json"),
        '{ // keep this\n "recommendations": ["someone.custom", /* choice */],\n}\n',
      );
      const plan = await planInit({ cwd: root, grammar: "postgres", editor: "vscode" }, "2.1.0");
      const result = await applyInitPlan(plan);
      strict.equal(result.state, "config-written");
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      strict.equal(manifest.dependencies["@typed-sql/postgres"], "workspace:*");
      strict.equal(manifest.scripts.check, "custom");
      strict.equal(manifest.devDependencies["@typed-sql/language-server"], "next");
      const settings = await readFile(join(root, ".vscode/settings.json"), "utf8");
      strict.match(settings, /\/\/ my theme/u);
      strict.equal(initJson(settings, "settings")["typedSql.providerMode"], "proxy");
      const extensions = await readFile(join(root, ".vscode/extensions.json"), "utf8");
      strict.match(extensions, /\/\* choice \*\//u);
      strict.deepEqual(initJson(extensions, "extensions").recommendations, [
        "someone.custom",
        "TypeScriptTeam.native-preview",
        "lojhan.typed-sql",
      ]);
      strict.match(await readFile(join(root, ".gitignore"), "utf8"), /\/\.typed-sql\//u);
      if (process.platform !== "win32") {
        strict.equal((await stat(join(root, "package.json"))).mode & 0o777, 0o600);
        strict.equal((await stat(result.journal)).mode & 0o777, 0o600);
      }
      strict.deepEqual((await planInit({ cwd: root, grammar: "postgres", editor: "vscode" }, "2.1.0")).files, []);
      strict.equal(JSON.parse(await readFile(result.journal, "utf8")).status, "completed");
    });
  });

  await it("rejects stale plans, overlapping paths, and competing setup locks before changing files", async () => {
    await fixture(async (root) => {
      await writeFile(join(root, "package.json"), "{}\n");
      const plan = await planInit({ cwd: root, grammar: "sqlite" }, "2.1.0");
      await writeFile(join(root, "package.json"), '{"name":"concurrent-edit"}\n');
      await strict.rejects(applyInitPlan(plan), /Concurrent edit/u);
      strict.equal(await readFile(join(root, "package.json"), "utf8"), '{"name":"concurrent-edit"}\n');
      await strict.rejects(stat(join(root, "typed-sql.config.ts")), { code: "ENOENT" });
      const fresh = await planInit({ cwd: root, grammar: "sqlite" }, "2.1.0");
      const release = await lock(root, { realpath: false, lockfilePath: join(root, ".typed-sql/init.lock") });
      try {
        await strict.rejects(applyInitPlan(fresh), /already being held/u);
      } finally {
        await release();
      }
      await strict.rejects(
        applyInitPlan({
          ...fresh,
          files: [
            { path: join(root, "nested"), beforeHash: null, content: "file" },
            { path: join(root, "nested/child"), beforeHash: null, content: "child" },
          ],
        }),
        /overlapping/u,
      );
      await strict.rejects(stat(join(root, "nested")), { code: "ENOENT" });
    });
  });

  await it("recovers a partially applied journal while preserving concurrent user edits", async () => {
    await fixture(async (root) => {
      await mkdir(join(root, ".typed-sql"));
      const original = join(root, "original.json");
      const created = join(root, "created.json");
      const journalPath = join(root, ".typed-sql/init-journal.json");
      const journal = {
        formatVersion: 1,
        root,
        status: "applying",
        files: [
          { path: original, before: "old", beforeMode: 0o600, after: "proposed", afterMode: 0o600 },
          { path: created, before: null, beforeMode: null, after: "new", afterMode: 0o600 },
        ],
      };
      await writeFile(original, "user edit", { mode: 0o600 });
      await writeFile(created, "new", { mode: 0o600 });
      await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
      const plan = await planInit({ cwd: root, grammar: "sqlite" }, "2.1.0");
      await strict.rejects(applyInitPlan(plan), /interrupted setup/u);
      await strict.rejects(recoverInit(root), /preserved concurrent edits/u);
      strict.equal(await readFile(original, "utf8"), "user edit");
      await strict.rejects(stat(created), { code: "ENOENT" });
      strict.equal(JSON.parse(await readFile(journalPath, "utf8")).status, "applying");
      await writeFile(original, "proposed");
      strict.deepEqual((await recoverInit(root)).files, [original]);
      strict.equal(await readFile(original, "utf8"), "old");
      strict.equal(JSON.parse(await readFile(journalPath, "utf8")).status, "rolled-back");
      strict.deepEqual((await recoverInit(root)).files, []);
    });
  });

  await it("refuses symlink ancestors, duplicate keys, and unsafe execution combinations", async () => {
    await fixture(async (root, boundary) => {
      const outside = join(boundary, "outside");
      await mkdir(outside);
      await symlink(outside, join(root, ".vscode"), "junction");
      await strict.rejects(planInit({ cwd: root, grammar: "mysql", editor: "vscode" }, "2.1.0"), /symlink/u);
      await writeFile(join(root, "package.json"), '{"scripts":{},"scripts":{}}');
      await strict.rejects(planInit({ cwd: root, grammar: "mysql" }, "2.1.0"), /Duplicate key/u);
      for (const options of [
        { install: "true" },
        { verify: "true" },
        { "allow-scripts": "true" },
        { "dry-run": "true", apply: "true" },
        { apply: "false" },
        { recover: "true", apply: "true" },
      ])
        await strict.rejects(runInit({ cwd: root, grammar: "sqlite", ...options }, "2.1.0"));
      await writeFile(join(root, "package.json"), "{}");
      const result = (await runInit({ cwd: root, grammar: "sqlite", apply: "true" }, "2.1.0")) as {
        state: string;
        hostVerified: boolean;
      };
      strict.equal(result.state, "config-written");
      strict.equal(result.hostVerified, false);
    });
  });
});
