import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadReleaseManifest } from "./release-policy.mjs";

const execFile = promisify(execFileCallback);
const workspace = resolve(import.meta.dirname, "..");
const hash = (algorithm, value) => createHash(algorithm).update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
};

async function files(directory) {
  const found = [];
  const visit = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const item = join(path, entry.name);
      if (entry.isDirectory()) await visit(item);
      else found.push(item);
    }
  };
  await visit(directory);
  return found.sort();
}

async function readRegularFile(path, name) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error(`Tarball contains unsupported non-file entry ${name}`);
    return { content: await file.readFile(), metadata };
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`Tarball contains unsupported non-file entry ${name}`);
    throw error;
  } finally {
    await file?.close();
  }
}

export async function inspectReleaseTarball(tarball) {
  const temporary = await mkdtemp(join(tmpdir(), "typed-sql-artifact-inspection-"));
  try {
    await execFile("tar", ["-xf", tarball, "-C", temporary]);
    const packageRoot = join(temporary, "package");
    const entries = [];
    const contents = new Map();
    for (const path of await files(packageRoot)) {
      const name = relative(packageRoot, path).replaceAll("\\", "/");
      const { content, metadata } = await readRegularFile(path, name);
      if (
        /(^|\/)(?:test|tests|fixtures|coverage|node_modules)(\/|$)/u.test(name) ||
        /(^|\/)\.env(?:\.|$)/u.test(name) ||
        /\.(?:key|pem|pcap|tsbuildinfo)$/u.test(name) ||
        (name.endsWith(".ts") && !name.endsWith(".d.ts"))
      ) {
        throw new Error(`Tarball contains forbidden development or sensitive file ${name}`);
      }
      if (content.includes(Buffer.from("/Users/")) || content.includes(Buffer.from("/home/runner/")))
        throw new Error(`Tarball contains a local absolute path in ${name}`);
      const reproducibleContent =
        name === "package.json"
          ? Buffer.from(`${JSON.stringify(canonical(JSON.parse(content.toString("utf8"))))}\n`)
          : content;
      entries.push({
        name,
        mode: metadata.mode & 0o777,
        size: reproducibleContent.length,
        sha256: hash("sha256", reproducibleContent),
      });
      contents.set(name, content);
    }
    const manifestSource = contents.get("package.json");
    if (manifestSource === undefined) throw new Error("Tarball has no package.json");
    const manifest = JSON.parse(manifestSource.toString("utf8"));
    for (const target of Object.values(typeof manifest.exports === "object" ? manifest.exports : {})) {
      const normalized = String(target).replace(/^\.\//u, "");
      if (!entries.some(({ name }) => name === normalized))
        throw new Error(`${manifest.name} export ${target} is absent`);
      const declaration = normalized.replace(/\.js$/u, ".d.ts");
      if (!entries.some(({ name }) => name === declaration))
        throw new Error(`${manifest.name} export ${target} has no declaration`);
    }
    for (const target of Object.values(manifest.bin ?? {})) {
      const normalized = String(target).replace(/^\.\//u, "");
      const entry = entries.find(({ name }) => name === normalized);
      if (entry === undefined) throw new Error(`${manifest.name} executable ${target} is absent`);
      if ((entry.mode & 0o111) === 0)
        throw new Error(`${manifest.name} executable ${target} has no execute permission`);
    }
    if (!entries.some(({ name }) => name === "LICENSE")) throw new Error(`${manifest.name} has no LICENSE`);
    for (const entry of entries.filter(({ name }) => name.endsWith(".map"))) {
      const sourceMap = JSON.parse(contents.get(entry.name).toString("utf8"));
      if ((sourceMap.sources ?? []).some((source) => isAbsolute(source)))
        throw new Error(`${manifest.name} source map ${entry.name} contains an absolute source`);
    }
    return {
      name: manifest.name,
      version: manifest.version,
      entries,
      contentSha256: hash("sha256", JSON.stringify(entries)),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function pack(name, destination) {
  const before = new Set(await readdir(destination));
  await execFile("pnpm", ["--silent", "--filter", name, "pack", "--pack-destination", destination], {
    cwd: workspace,
  });
  const archive = (await readdir(destination)).find((entry) => !before.has(entry));
  if (archive === undefined) throw new Error(`pnpm pack did not produce ${name}`);
  return join(destination, archive);
}

export async function verifyReleaseArtifacts() {
  const release = await loadReleaseManifest(workspace);
  const packageNames = [...release.packagePolicy.stable, ...release.packagePolicy.experimental];
  const temporary = await mkdtemp(join(tmpdir(), "typed-sql-release-artifacts-"));
  try {
    const firstDirectory = join(temporary, "first");
    const secondDirectory = join(temporary, "second");
    await mkdir(firstDirectory);
    await mkdir(secondDirectory);
    const subjects = [];
    for (const name of packageNames) {
      const firstTarball = await pack(name, firstDirectory);
      const secondTarball = await pack(name, secondDirectory);
      const [first, second, firstBytes, secondBytes] = await Promise.all([
        inspectReleaseTarball(firstTarball),
        inspectReleaseTarball(secondTarball),
        readFile(firstTarball),
        readFile(secondTarball),
      ]);
      if (first.contentSha256 !== second.contentSha256)
        throw new Error(`${name} rebuilt with different package contents`);
      const firstIntegrity = hash("sha512", firstBytes);
      const secondIntegrity = hash("sha512", secondBytes);
      subjects.push({
        name,
        version: first.version,
        integrity: `sha512:${firstIntegrity}`,
        contentSha256: first.contentSha256,
        bytes: firstBytes.length,
        entries: first.entries.length,
        reproducibility:
          firstIntegrity === secondIntegrity ? "byte-identical" : "content-identical-normalized-package-metadata",
      });
    }
    return Object.freeze({
      formatVersion: 1,
      source: { repository: "Lojhan/typed-sql", revision: process.env.GITHUB_SHA ?? "local" },
      builder: { runtime: process.version, packageManager: "pnpm@10.32.1", oidcProvenance: true },
      subjects: Object.freeze(subjects),
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex < 0 ? undefined : resolve(workspace, process.argv[outputIndex + 1] ?? "");
  const report = await verifyReleaseArtifacts();
  if (output !== undefined) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
