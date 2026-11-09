import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(callback);
const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const run = (cwd, program, args) => execFile(program, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
const sourceRevision = (await run(root, "git", ["rev-parse", "HEAD"])).stdout.trim();
assert.equal(
  (await run(root, "git", ["status", "--porcelain", "--untracked-files=all", "--", "packages", "pnpm-lock.yaml"]))
    .stdout,
  "",
  "Commit package inputs before measuring publication payloads",
);
const grammars = Object.keys((await json(join(root, "grammar/features/ledger.json"))).dialects).sort();
const workspace = new Map();
for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = join(root, "packages", entry.name);
  try {
    const metadata = await json(join(directory, "package.json"));
    workspace.set(metadata.name, { directory, metadata });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const dependencyNames = (metadata) =>
  [
    ...new Set([...Object.keys(metadata.dependencies ?? {}), ...Object.keys(metadata.optionalDependencies ?? {})]),
  ].sort();
async function dependency(from, name, optional = false) {
  let current = from;
  for (;;) {
    try {
      return await realpath(join(current, "node_modules", name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) {
      if (optional) return undefined;
      throw Error(`Missing installed dependency ${name}`);
    }
    current = parent;
  }
}
const selected = new Map(),
  externalVersions = {};
async function select(directory) {
  directory = await realpath(directory);
  if (selected.has(directory)) return;
  const metadata = await json(join(directory, "package.json"));
  selected.set(directory, metadata);
  if (!workspace.has(metadata.name)) {
    if (externalVersions[metadata.name] && externalVersions[metadata.name] !== metadata.version)
      throw Error(`Conflicting external versions for ${metadata.name}`);
    externalVersions[metadata.name] = metadata.version;
  }
  for (const name of dependencyNames(metadata)) {
    const child = await dependency(directory, name, Object.hasOwn(metadata.optionalDependencies ?? {}, name));
    if (child) await select(child);
  }
}
const roots = [...grammars.map((name) => `@typed-sql/${name}`), "@typed-sql/compiler", "@typed-sql/analysis"];
for (const name of roots) {
  assert.ok(workspace.has(name));
  await select(workspace.get(name).directory);
}
const temporary = await mkdtemp(join(tmpdir(), "typed-sql-install-measurement-"));
try {
  const archives = {},
    tarballs = {};
  for (const metadata of selected.values()) {
    if (!workspace.has(metadata.name)) continue;
    const location = workspace.get(metadata.name).directory;
    const archive = join(temporary, `${metadata.name.replaceAll("/", "-").replace("@", "")}.tgz`);
    await run(location, "pnpm", ["pack", "--out", archive]);
    archives[metadata.name] = `file:${archive}`;
    const bytes = await readFile(archive);
    tarballs[metadata.name] = { bytes: bytes.length, digest: hash(bytes) };
  }
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({
      name: "isolated-payload-measurement",
      private: true,
      type: "module",
      dependencies: archives,
      pnpm: { overrides: { ...archives, ...externalVersions } },
    }),
  );
  await run(temporary, "pnpm", ["install", "--offline", "--ignore-workspace", "--ignore-scripts"]);
  const packages = new Map();
  async function payload(directory) {
    const files = [];
    const sizes = { javascript: 0, declarations: 0, sourceMaps: 0, other: 0 };
    async function walk(base, prefix = "") {
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const relative = prefix + entry.name,
          path = join(base, entry.name);
        if (entry.isDirectory()) await walk(path, `${relative}/`);
        else if (entry.isFile()) {
          const bytes = await readFile(path);
          const category = relative.endsWith(".map")
            ? "sourceMaps"
            : /\.d\.[cm]?ts$/u.test(relative)
              ? "declarations"
              : /\.[cm]?js$/u.test(relative)
                ? "javascript"
                : "other";
          sizes[category] += bytes.length;
          files.push([relative, bytes.length, hash(bytes)]);
        } else throw Error(`Unexpected published payload entry ${relative}`);
      }
    }
    await walk(directory);
    files.sort(([a], [b]) => a.localeCompare(b));
    return {
      fileCount: files.length,
      bytes: Object.values(sizes).reduce((a, b) => a + b, 0),
      sizes,
      digest: hash(JSON.stringify(files)),
    };
  }
  async function collect(directory) {
    directory = await realpath(directory);
    const metadata = await json(join(directory, "package.json"));
    const id = `${metadata.name}@${metadata.version}`;
    if (packages.has(id)) return id;
    const details = {
      name: metadata.name,
      version: metadata.version,
      payload: await payload(directory),
      dependencies: [],
      unavailableOptionalDependencies: [],
      ...(tarballs[metadata.name] ? { tarball: tarballs[metadata.name] } : {}),
    };
    packages.set(id, details);
    for (const name of dependencyNames(metadata)) {
      const child = await dependency(directory, name, Object.hasOwn(metadata.optionalDependencies ?? {}, name));
      if (child) details.dependencies.push(await collect(child));
      else details.unavailableOptionalDependencies.push(name);
    }
    return id;
  }
  const ids = {};
  for (const name of roots) ids[name] = await collect(await dependency(temporary, name));
  function closure(roots) {
    const visited = new Set();
    const visit = (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const child of packages.get(id).dependencies) visit(child);
    };
    roots.forEach(visit);
    return {
      packages: visited.size,
      payloadBytes: [...visited].reduce((sum, id) => sum + packages.get(id).payload.bytes, 0),
    };
  }
  const rows = grammars.map((grammar) => ({
    grammar,
    grammarPackage: packages.get(ids[`@typed-sql/${grammar}`]).payload,
    grammarClosure: closure([ids[`@typed-sql/${grammar}`]]),
    withCompilerAndContracts: closure([
      ids[`@typed-sql/${grammar}`],
      ids["@typed-sql/compiler"],
      ids["@typed-sql/analysis"],
    ]),
  }));
  const report = {
    formatVersion: 1,
    sourceRevision,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pnpmVersion: (await run(root, "pnpm", ["--version"])).stdout.trim(),
    repositoryLockfileDigest: hash(await readFile(join(root, "pnpm-lock.yaml"))),
    installationLockfileDigest: hash(
      (await readFile(join(temporary, "pnpm-lock.yaml"), "utf8"))
        .replaceAll(temporary, "<measurement-root>")
        .replaceAll(await realpath(temporary), "<measurement-root>"),
    ),
    measurementToolDigest: hash(await readFile(fileURLToPath(import.meta.url))),
    method:
      "Fresh isolated offline pnpm install of built tarballs. External dependency versions are pinned to the repository installation. Payload counts published file contents once per package name/version, excluding node_modules, filesystem blocks, pnpm store, optional peers and application-installed drivers/toolchains. This is not bundle size or total disk usage.",
    externalVersions,
    rows,
    packages: Object.fromEntries([...packages].sort(([a], [b]) => a.localeCompare(b))),
  };
  const output = join(root, "planning/hybrid-analysis/installation-measurements.json");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  await run(root, resolve(root, "node_modules/.bin/biome"), ["format", "--write", output]);
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
