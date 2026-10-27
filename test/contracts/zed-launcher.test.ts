import { execFile as callback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";

const execFile = promisify(callback);
const workspace = resolve(import.meta.dirname, "../..");
const launcher = await readFile(join(workspace, "editors/zed/src/launch-server.cjs"), "utf8");
const run = (root: string, fallback = "") =>
  execFile(process.execPath, ["--input-type=commonjs", "--eval", launcher, root, fallback, "--stdio"], {
    timeout: 10_000,
  });

await describe("Zed's application-installed server resolver", async () => {
  await it("follows external pnpm symlinks and hoisted packages before PATH without loading package entrypoints", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "typed-sql-zed-resolve-")));
    try {
      const root = join(temporary, "workspace");
      const app = join(root, "apps/api");
      const store = join(temporary, "outside-worktree-store");
      await mkdir(join(root, "node_modules/@typed-sql"), { recursive: true });
      await mkdir(app, { recursive: true });
      await mkdir(join(store, "dist"), { recursive: true });
      await writeFile(
        join(store, "package.json"),
        JSON.stringify({ name: "@typed-sql/language-server", type: "module", exports: { ".": "./dist/index.js" } }),
      );
      await writeFile(join(store, "dist/index.js"), 'throw new Error("Package entrypoint must not execute");');
      await writeFile(
        join(store, "dist/server.js"),
        'console.log(JSON.stringify({ source: "installed", root: process.cwd(), arguments: process.argv.slice(1) }));',
      );
      await symlink(store, join(root, "node_modules/@typed-sql/language-server"), "junction");
      strict.deepEqual(JSON.parse((await run(app, join(temporary, "must-not-run"))).stdout), {
        source: "installed",
        root: app,
        arguments: [join(store, "dist/server.js"), "--stdio"],
      });
      await rm(join(store, "dist/server.js"));
      await strict.rejects(run(app, join(temporary, "must-not-run")), /Installed language server is incomplete/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("preserves PATH-before-development fallback and reports a missing installation", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "typed-sql-zed-fallback-")));
    try {
      const root = join(temporary, "app");
      const server = join(root, "packages/language-server/dist/packages/language-server/src");
      await mkdir(server, { recursive: true });
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      await writeFile(join(root, "packages/language-server/package.json"), "{}");
      await writeFile(join(server, "server.js"), 'console.log(JSON.stringify({source: "development"}));');
      const bin = join(temporary, "path & server");
      await mkdir(bin);
      const shim = join(
        bin,
        process.platform === "win32" ? "typed-sql-language-server.cmd" : "typed-sql-language-server",
      );
      await writeFile(
        shim,
        process.platform === "win32"
          ? '@echo off\r\necho {"source":"path"}\r\n'
          : '#!/bin/sh\necho \'{"source":"path"}\'\n',
      );
      await chmod(shim, 0o755);
      strict.equal(JSON.parse((await run(root, shim)).stdout).source, "path");
      strict.equal(JSON.parse((await run(root)).stdout).source, "development");
      await rm(join(root, "packages"), { recursive: true });
      await strict.rejects(run(root), /pnpm add -D @typed-sql\/language-server/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
