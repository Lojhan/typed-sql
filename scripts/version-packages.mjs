import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseManifest } from "./release-policy.mjs";

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

function rewriteLatestRelease(changelog, provisionalVersion, targetVersion, packageName) {
  const heading = `## ${provisionalVersion}\n`;
  const start = changelog.indexOf(heading);
  if (start < 0) throw new Error(`${packageName} changelog is missing ${heading.trim()}`);
  const nextRelease = changelog.indexOf("\n## ", start + heading.length);
  const end = nextRelease < 0 ? changelog.length : nextRelease;
  return `${changelog.slice(0, start)}${changelog.slice(start, end).replaceAll(provisionalVersion, targetVersion)}${changelog.slice(end)}`;
}

export async function normalizeReleaseCandidateVersions(workspace, release, originalVersions, number) {
  const targetVersion = `${release.series}-rc.${number}`;
  for (const name of release.packages) {
    const directory = packageDirectory(workspace, name);
    const manifestPath = join(directory, "package.json");
    const changelogPath = join(directory, "CHANGELOG.md");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const provisionalVersion = manifest.version;
    const changedByChangesets = provisionalVersion !== originalVersions.get(name);
    manifest.version = targetVersion;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    let changelog = await readFile(changelogPath, "utf8");
    if (changedByChangesets && provisionalVersion !== targetVersion) {
      changelog = rewriteLatestRelease(changelog, provisionalVersion, targetVersion, name);
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
