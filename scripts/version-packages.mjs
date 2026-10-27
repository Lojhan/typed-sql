import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gt, inc, rcompare, valid } from "semver";
import { detectPendingChangesets } from "./detect-pending-changesets.mjs";
import { loadReleaseManifest, validateReleaseManifest } from "./release-policy.mjs";

const defaultWorkspace = fileURLToPath(new URL("..", import.meta.url));
const changesetsCli = fileURLToPath(new URL("../node_modules/@changesets/cli/bin.js", import.meta.url));

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function packageDirectory(workspace, name) {
  return join(workspace, "packages", name.slice("@typed-sql/".length));
}

function run(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

export function nextReleaseCandidateNumber(versions, series) {
  const pattern = new RegExp(`^${escapeRegularExpression(series)}-rc\\.(\\d+)$`, "u");
  let highest = -1;
  for (const version of versions) {
    const match = pattern.exec(version);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

function addReleaseHeading(changelog, targetVersion) {
  const newline = changelog.indexOf("\n");
  if (newline < 0) throw new Error("Package changelog must begin with a title");
  return `${changelog.slice(0, newline)}\n\n## ${targetVersion}\n\n### Patch Changes\n\n- Publish the coherent ${targetVersion} release-candidate train.\n${changelog.slice(newline + 1)}`;
}

function rewriteLatestRelease(changelog, provisionalVersion, provisionalVersions, targetVersion, packageName, series) {
  const heading = `## ${provisionalVersion}\n`;
  const start = changelog.indexOf(heading);
  if (start < 0) throw new Error(`${packageName} changelog is missing ${heading.trim()}`);
  const nextRelease = changelog.indexOf("\n## ", start + heading.length);
  const end = nextRelease < 0 ? changelog.length : nextRelease;
  const prereleaseVersion = new RegExp(`${escapeRegularExpression(series)}-(?:beta|rc)\\.\\d+`, "gu");
  const versions = [...new Set([provisionalVersion, ...provisionalVersions])].sort((a, b) => b.length - a.length);
  const references = new RegExp(
    `(@typed-sql/[a-z][a-z0-9-]*@)(?:${versions.map(escapeRegularExpression).join("|")}|${prereleaseVersion.source})(?![\\w-])`,
    "gu",
  );
  // Normalize dependency references and this heading, leaving bare historical
  // version numbers in the author's release prose untouched.
  const normalized = `## ${targetVersion}\n${changelog.slice(start + heading.length, end)}`.replace(
    references,
    (_match, name) => `${name}${targetVersion}`,
  );
  return `${changelog.slice(0, start)}${normalized}${changelog.slice(end)}`;
}

export async function normalizeReleaseCandidateVersions(workspace, release, originalVersions, number) {
  const targetVersion = `${release.series}-rc.${number}`;
  const packages = [];
  for (const name of release.packages) {
    const directory = packageDirectory(workspace, name);
    const manifestPath = join(directory, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    packages.push({ name, directory, manifestPath, manifest, provisionalVersion: manifest.version });
  }
  const provisionalVersions = new Set(packages.map(({ provisionalVersion }) => provisionalVersion));
  for (const { name, directory, manifestPath, manifest, provisionalVersion } of packages) {
    const changelogPath = join(directory, "CHANGELOG.md");
    const changedByChangesets = provisionalVersion !== originalVersions.get(name);
    manifest.version = targetVersion;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    let changelog = await readFile(changelogPath, "utf8");
    if (changedByChangesets && provisionalVersion !== targetVersion) {
      changelog = rewriteLatestRelease(
        changelog,
        provisionalVersion,
        provisionalVersions,
        targetVersion,
        name,
        release.series,
      );
    }
    if (!changelog.includes(`## ${targetVersion}\n`)) changelog = addReleaseHeading(changelog, targetVersion);
    await writeFile(changelogPath, changelog);
  }
  return targetVersion;
}

export async function versionPackages(options = {}) {
  const workspace = resolve(options.workspace ?? defaultWorkspace);
  const release = await loadReleaseManifest(workspace);
  const runCommand = options.runCommand ?? run;
  if (release.channel === "stable") {
    if ((await detectPendingChangesets(workspace)).length === 0) return undefined;
    const names = [...release.packagePolicy.stable, ...release.packagePolicy.experimental];
    const original = new Map();
    for (const name of names) {
      const manifest = JSON.parse(await readFile(join(packageDirectory(workspace, name), "package.json"), "utf8"));
      original.set(name, manifest.version);
    }
    await runCommand(process.execPath, [changesetsCli, "version"], workspace);
    const versions = [];
    for (const name of release.packagePolicy.stable) {
      const manifest = JSON.parse(await readFile(join(packageDirectory(workspace, name), "package.json"), "utf8"));
      if (valid(manifest.version) === null || manifest.version.includes("-"))
        throw new Error(`Invalid stable version proposal for ${name}`);
      versions.push(manifest.version);
    }
    const highest = versions.sort(rcompare)[0];
    const series = gt(highest, release.series) ? highest : inc(release.series, "patch");
    const { sourceCandidate: _previousCandidate, ...previous } = release;
    const candidate = validateReleaseManifest({ ...previous, channel: "rc", npmTag: "next", series, packages: names });
    const target = await normalizeReleaseCandidateVersions(workspace, candidate, original, 0);
    await writeFile(join(workspace, "release-manifest.json"), `${JSON.stringify(candidate, null, 2)}\n`);
    await runCommand("pnpm", ["exec", "biome", "format", "--write", "release-manifest.json"], workspace);
    await runCommand(process.execPath, [changesetsCli, "pre", "enter", "rc"], workspace);
    await runCommand("pnpm", ["install", "--lockfile-only", "--offline", "--ignore-scripts"], workspace);
    process.stdout.write(`Prepared coherent release candidate ${target}\n`);
    return target;
  }
  if (release.channel !== "rc") {
    await runCommand(process.execPath, [changesetsCli, "version"], workspace);
    return undefined;
  }

  const pre = JSON.parse(await readFile(join(workspace, ".changeset", "pre.json"), "utf8"));
  if (pre.mode !== "pre" || pre.tag !== "rc") throw new Error("RC versioning requires Changesets rc prerelease mode");
  const originalVersions = new Map();
  for (const name of release.packages) {
    const manifest = JSON.parse(await readFile(join(packageDirectory(workspace, name), "package.json"), "utf8"));
    originalVersions.set(name, manifest.version);
  }
  const number = nextReleaseCandidateNumber(originalVersions.values(), release.series);
  await runCommand(process.execPath, [changesetsCli, "version"], workspace);
  const targetVersion = await normalizeReleaseCandidateVersions(workspace, release, originalVersions, number);
  await runCommand("pnpm", ["install", "--lockfile-only", "--offline", "--ignore-scripts"], workspace);
  process.stdout.write(`Versioned coherent release candidate ${targetVersion}\n`);
  return targetVersion;
}

export async function main() {
  await versionPackages();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
