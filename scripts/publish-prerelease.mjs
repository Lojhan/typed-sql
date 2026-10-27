import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gt, valid } from "semver";
import { loadReleaseManifest } from "./release-policy.mjs";

const defaultWorkspace = fileURLToPath(new URL("..", import.meta.url));
const changesetsCli = fileURLToPath(new URL("../node_modules/@changesets/cli/bin.js", import.meta.url));
const registry = "https://registry.npmjs.org";

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function packageDirectory(workspace, name) {
  const prefix = "@typed-sql/";
  if (!name.startsWith(prefix)) throw new Error(`Release package ${name} is outside the @typed-sql scope`);
  const directory = name.slice(prefix.length);
  if (!/^[a-z][a-z0-9-]*$/u.test(directory)) throw new Error(`Unsafe release package name: ${name}`);
  return join(workspace, "packages", directory);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${options.label ?? command} failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

export async function loadReleasePlan(requestedChannel, workspace = defaultWorkspace) {
  const release = await loadReleaseManifest(workspace);
  if (release.channel !== requestedChannel) {
    throw new Error(`Expected ${requestedChannel} release, found ${release.channel}:${release.npmTag}`);
  }

  const versionPattern =
    requestedChannel === "stable"
      ? new RegExp(`^${escapeRegularExpression(release.series)}$`, "u")
      : new RegExp(`^${escapeRegularExpression(release.series)}-${requestedChannel}\\.\\d+$`, "u");
  const packages = [];
  for (const expectedName of release.packages) {
    const directory = packageDirectory(workspace, expectedName);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (manifest.name !== expectedName) {
      throw new Error(`${directory}/package.json declares ${manifest.name}, expected ${expectedName}`);
    }
    if (!versionPattern.test(manifest.version)) {
      throw new Error(
        `${manifest.name}@${manifest.version} is not a valid ${requestedChannel} version for ${release.series}`,
      );
    }
    packages.push({ name: manifest.name, version: manifest.version, directory });
  }

  return { npmTag: release.npmTag, packages };
}

export async function loadExperimentalCompanionPlan(workspace = defaultWorkspace) {
  const release = await loadReleaseManifest(workspace);
  if (release.channel !== "stable") {
    throw new Error(`Experimental companion publication requires stable, found ${release.channel}:${release.npmTag}`);
  }

  const versionPattern = new RegExp(`^${escapeRegularExpression(release.series)}-(?:beta|rc)\\.\\d+$`, "u");
  const packages = [];
  for (const expectedName of release.packagePolicy.experimental) {
    const directory = packageDirectory(workspace, expectedName);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (manifest.name !== expectedName) {
      throw new Error(`${directory}/package.json declares ${manifest.name}, expected ${expectedName}`);
    }
    if (!versionPattern.test(manifest.version)) {
      throw new Error(`${manifest.name}@${manifest.version} is not an experimental version for ${release.series}`);
    }
    packages.push({ name: manifest.name, version: manifest.version, directory });
  }

  // Experimental is a contract classification, independent of npm's default
  // install tag. Keep versionless installs on the current experimental backend.
  return { npmTag: "next", additionalTags: ["latest"], packages };
}

export async function loadPrereleasePlan(workspace = defaultWorkspace) {
  return loadReleasePlan("beta", workspace);
}

export async function isPublishedOnNpm(name, version, options = {}) {
  const encodedName = encodeURIComponent(name).replace(/^%40/u, "@");
  const fetchVersion = options.fetch ?? fetch;
  const wait = options.wait ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const attempts = options.attempts ?? 3;
  let lastFailure;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchVersion(`${registry}/${encodedName}/${encodeURIComponent(version)}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      lastFailure = error;
    }
    if (response !== undefined) {
      if (response.status === 200) return true;
      if (response.status === 404) return false;
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`npm registry lookup failed for ${name}@${version}: HTTP ${response.status}`);
      }
      lastFailure = new Error(`npm registry lookup failed for ${name}@${version}: HTTP ${response.status}`);
    }
    if (attempt < attempts) await wait(250 * 2 ** (attempt - 1));
  }

  throw new Error(`Unable to determine whether ${name}@${version} is already published`, {
    cause: lastFailure,
  });
}

export function publicationCommands(pkg, npmTag, tarballPath) {
  return [
    { command: "pnpm", args: ["pack", "--out", tarballPath], cwd: pkg.directory },
    {
      command: "npm",
      args: ["publish", tarballPath, "--access", "public", "--tag", npmTag, "--provenance"],
      cwd: pkg.directory,
    },
  ];
}

export async function npmDistTags(name, options = {}) {
  const encodedName = encodeURIComponent(name).replace(/^%40/u, "@");
  const lookup = options.fetch ?? fetch;
  const wait = options.wait ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  let failure;
  for (let attempt = 1; attempt <= (options.attempts ?? 3); attempt += 1) {
    let response;
    try {
      response = await lookup(`${registry}/-/package/${encodedName}/dist-tags`, {
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      failure = error;
    }
    if (response?.status === 404) return {};
    if (response?.status === 200) {
      const tags = await response.json();
      if (
        tags === null ||
        typeof tags !== "object" ||
        Array.isArray(tags) ||
        Object.values(tags).some((version) => typeof version !== "string" || valid(version) === null)
      )
        throw new Error(`Invalid npm dist-tags for ${name}`);
      return tags;
    }
    if (response !== undefined) {
      failure = new Error(`npm dist-tag lookup failed for ${name}: HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) throw failure;
    }
    if (attempt < (options.attempts ?? 3)) await wait(250 * 2 ** (attempt - 1));
  }
  throw new Error(`Unable to read npm dist-tags for ${name}`, { cause: failure });
}

async function setNpmDistTag(pkg, tag) {
  await run("npm", ["dist-tag", "add", `${pkg.name}@${pkg.version}`, tag, "--registry", registry], {
    cwd: pkg.directory,
    label: `Repairing ${pkg.name} ${tag}`,
  });
}

async function publishWithNpm(pkg, npmTag) {
  const temporary = await mkdtemp(join(tmpdir(), "typed-sql-publish-"));
  const tarballPath = join(temporary, `${pkg.name.slice("@typed-sql/".length)}-${pkg.version}.tgz`);
  try {
    const [pack, publish] = publicationCommands(pkg, npmTag, tarballPath);
    await run(pack.command, pack.args, { cwd: pack.cwd, label: `Packing ${pkg.name}@${pkg.version}` });
    await run(publish.command, publish.args, {
      cwd: publish.cwd,
      label: `Publishing ${pkg.name}@${pkg.version}`,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function createChangesetsTags(workspace) {
  await run(process.execPath, [changesetsCli, "git-tag"], {
    cwd: workspace,
    env: process.env,
    label: "Creating release tags",
  });
}

export async function publishRelease(options = {}) {
  const workspace = options.workspace ?? defaultWorkspace;
  const requestedChannel = options.channel ?? "beta";
  const plan = options.plan ?? (await loadReleasePlan(requestedChannel, workspace));
  const companionPlan =
    requestedChannel === "stable"
      ? (options.companionPlan ??
        (options.plan === undefined ? await loadExperimentalCompanionPlan(workspace) : undefined))
      : undefined;
  const isPublished = options.isPublished ?? isPublishedOnNpm;
  const publishPackage = options.publishPackage ?? publishWithNpm;
  const getTags = options.getTags ?? npmDistTags;
  const setTag = options.setTag ?? setNpmDistTag;
  const createTags = options.createTags ?? createChangesetsTags;
  const log = options.log ?? console.log;

  for (const currentPlan of companionPlan === undefined ? [plan] : [plan, companionPlan]) {
    for (const pkg of currentPlan.packages) {
      if (valid(pkg.version) === null) throw new Error(`Invalid package release version: ${pkg.version}`);
      const tags = [currentPlan.npmTag, ...(currentPlan.additionalTags ?? [])];
      if (tags.some((tag) => !["next", "latest"].includes(tag))) throw new Error("Unsupported npm release tag");
      const current = { ...(await getTags(pkg.name)) };
      for (const version of Object.values(current))
        if (typeof version !== "string" || valid(version) === null)
          throw new Error(`Invalid npm dist-tag version for ${pkg.name}`);
      if (await isPublished(pkg.name, pkg.version)) {
        log(`Skipping ${pkg.name}@${pkg.version}: already published.`);
      } else {
        if (current[currentPlan.npmTag] !== undefined && gt(current[currentPlan.npmTag], pkg.version))
          throw new Error(
            `Refusing to publish stale ${pkg.name}@${pkg.version}: ${currentPlan.npmTag} is ${current[currentPlan.npmTag]}`,
          );
        log(`Publishing ${pkg.name}@${pkg.version} to npm tag ${currentPlan.npmTag}.`);
        await publishPackage(pkg, currentPlan.npmTag);
        current[currentPlan.npmTag] = pkg.version;
      }
      // A registry may accept a version before a workflow loses its response.
      // On retry reconcile tags even when the immutable version already exists.
      for (const tag of new Set(tags)) {
        if (current[tag] === pkg.version) continue;
        if (current[tag] !== undefined && gt(current[tag], pkg.version)) {
          log(`Keeping newer ${pkg.name} ${tag}@${current[tag]}.`);
          continue;
        }
        await setTag(pkg, tag);
        current[tag] = pkg.version;
      }
    }
  }

  await createTags(workspace);
}

export async function publishPrerelease(options = {}) {
  return publishRelease({ ...options, channel: "beta" });
}

export async function publishExperimentalCompanions(options = {}) {
  const workspace = options.workspace ?? defaultWorkspace;
  const plan = options.plan ?? (await loadExperimentalCompanionPlan(workspace));
  // This preparation step runs before stable publication and outside the
  // Changesets action. Defer Git tags to the complete publisher so its output
  // report includes the newly created tags and the action can push them.
  return publishRelease({
    ...options,
    channel: "stable",
    workspace,
    plan,
    companionPlan: undefined,
    createTags: async () => undefined,
  });
}

export async function main() {
  const requestedChannel = process.argv[2] ?? "beta";
  if (requestedChannel === "companions") {
    await publishExperimentalCompanions();
    return;
  }
  if (requestedChannel !== "beta" && requestedChannel !== "rc" && requestedChannel !== "stable") {
    throw new Error("Usage: node scripts/publish-prerelease.mjs <beta|rc|stable|companions>");
  }
  await publishRelease({ channel: requestedChannel });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
