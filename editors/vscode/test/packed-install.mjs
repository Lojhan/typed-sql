import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(callback);
export async function installPackedServer(root, run) {
  const tarballs = join(run, "tarballs");
  const consumer = join(run, "installed");
  await mkdir(tarballs);
  await mkdir(consumer);
  const dependencies = {};
  // Include each workspace dependency in the isolated install, never resolve a
  // prerelease workspace package from the registry or link production sources.
  const directories = [
    "ast",
    "core",
    "config",
    "schema",
    "compiler",
    "conformance",
    "postgres",
    "mysql",
    "sqlite",
    "ts-bridge",
    "language-server",
  ].map((name) => `packages/${name}`);
  directories.push("examples/synthetic-grammar");
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"));
    const before = new Set(await readdir(tarballs));
    await execFile("pnpm", ["pack", "--pack-destination", tarballs], { cwd: join(root, directory), timeout: 60_000 });
    const added = (await readdir(tarballs)).filter((name) => !before.has(name));
    assert.equal(added.length, 1, `one archive for ${manifest.name}`);
    dependencies[manifest.name] = `file:${join(tarballs, added[0])}`;
  }
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies, pnpm: { overrides: dependencies } }),
  );
  const { NODE_PATH: _nodePath, ...env } = process.env;
  await execFile("pnpm", ["install", "--ignore-workspace", "--ignore-scripts", "--no-frozen-lockfile"], {
    cwd: consumer,
    env: { ...env, CI: "true" },
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(join(run, "packed-install.json"), JSON.stringify({ consumer, dependencies }, null, 2));
  return consumer;
}
