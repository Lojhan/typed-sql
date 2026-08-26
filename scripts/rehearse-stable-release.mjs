import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseManifest } from "./release-policy.mjs";

const defaultWorkspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changesetPattern = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u;
const releaseLinePattern = /^"(@typed-sql\/[a-z][a-z0-9-]*)": (patch|minor|major)$/u;

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const capture = options.capture === true;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else
        rejectRun(new Error(`${options.label ?? command} failed (${signal ?? code ?? "unknown"})\n${stdout}${stderr}`));
    });
  });
}

function formatChangeset(lines, body) {
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

export function splitChangeset(text, experimentalPackages) {
  const match = changesetPattern.exec(text);
  if (match === null) throw new Error("Invalid Changeset frontmatter");
  const lines = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!releaseLinePattern.test(line)) throw new Error(`Unsupported Changeset release line: ${line}`);
  }
  const stable = lines.filter((line) => !experimentalPackages.has(releaseLinePattern.exec(line)?.[1]));
  const experimental = lines.filter((line) => experimentalPackages.has(releaseLinePattern.exec(line)?.[1]));
  const body = match[2];
  return {
    stable: stable.length === 0 ? undefined : formatChangeset(stable, body),
    experimental: experimental.length === 0 ? undefined : formatChangeset(experimental, body),
  };
}

async function packageState(workspace, packageNames) {
  const state = new Map();
  for (const name of packageNames) {
    const directory = join(workspace, "packages", name.slice("@typed-sql/".length));
    state.set(name, {
      manifest: await readFile(join(directory, "package.json"), "utf8"),
      changelog: await readFile(join(directory, "CHANGELOG.md"), "utf8"),
    });
  }
  return state;
}

async function partitionChangesets(workspace, experimentalPackages) {
  const directory = join(workspace, ".changeset");
  const deferred = new Map();
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const path = join(directory, file);
    const parts = splitChangeset(await readFile(path, "utf8"), experimentalPackages);
    if (parts.experimental !== undefined) deferred.set(file, parts.experimental);
    if (parts.stable === undefined) await rm(path);
    else await writeFile(path, parts.stable);
  }
  return deferred;
}

async function restoreExperimentalState(workspace, state, deferredChangesets) {
  for (const [name, files] of state) {
    const directory = join(workspace, "packages", name.slice("@typed-sql/".length));
    await writeFile(join(directory, "package.json"), files.manifest);
    await writeFile(join(directory, "CHANGELOG.md"), files.changelog);
  }
  for (const [file, text] of deferredChangesets) {
    await writeFile(join(workspace, ".changeset", file), text);
  }
}

async function releaseCandidateVersion(workspace, release) {
  const versions = new Set();
  for (const name of release.packages) {
    const manifest = JSON.parse(
      await readFile(join(workspace, "packages", name.slice("@typed-sql/".length), "package.json"), "utf8"),
    );
    versions.add(manifest.version);
  }
  if (versions.size !== 1) throw new Error("Stable rehearsal requires one coherent release-candidate version");
  const [candidate] = versions;
  const pattern = new RegExp(`^${release.series.replaceAll(".", "\\.")}-rc\\.\\d+$`, "u");
  if (typeof candidate !== "string" || !pattern.test(candidate)) {
    throw new Error(`Stable rehearsal requires a ${release.series}-rc.N candidate`);
  }
  return candidate;
}

async function writeStableManifest(workspace, release, sourceCandidate) {
  await writeFile(
    join(workspace, "release-manifest.json"),
    `${JSON.stringify(
      {
        ...release,
        channel: "stable",
        npmTag: "latest",
        sourceCandidate,
        packages: release.packagePolicy.stable,
      },
      null,
      2,
    )}\n`,
  );
}

export async function prepareStableVersion(workspace, options = {}) {
  const release = await loadReleaseManifest(workspace);
  if (release.channel !== "rc" || release.npmTag !== "next") {
    throw new Error(`Stable rehearsal must begin on rc:next, received ${release.channel}:${release.npmTag}`);
  }
  const experimentalPackages = new Set(release.packagePolicy.experimental);
  const sourceCandidate = await releaseCandidateVersion(workspace, release);
  const state = await packageState(workspace, experimentalPackages);
  const deferred = await partitionChangesets(workspace, experimentalPackages);
  const runCommand = options.runCommand ?? run;
  const changesetsCli = join(workspace, "node_modules/@changesets/cli/bin.js");

  await runCommand(process.execPath, [changesetsCli, "pre", "exit"], {
    cwd: workspace,
    label: "Exiting Changesets prerelease mode",
  });
  await runCommand(process.execPath, [changesetsCli, "version"], {
    cwd: workspace,
    label: "Versioning stable packages",
  });
  await restoreExperimentalState(workspace, state, deferred);
  await writeStableManifest(workspace, release, sourceCandidate);
  await runCommand("pnpm", ["exec", "biome", "format", "--write", "release-manifest.json"], {
    cwd: workspace,
    label: "Formatting the rehearsed release manifest",
  });
  await runCommand("pnpm", ["install", "--lockfile-only", "--offline", "--ignore-scripts"], {
    cwd: workspace,
    label: "Refreshing the rehearsed lockfile",
  });

  return loadReleaseManifest(workspace);
}

export async function assertStableVersionState(workspace) {
  const release = await loadReleaseManifest(workspace);
  if (release.channel !== "stable" || release.npmTag !== "latest") {
    throw new Error(`Rehearsed manifest is not stable:latest`);
  }
  const versions = {};
  for (const name of release.packagePolicy.stable) {
    const manifest = JSON.parse(
      await readFile(join(workspace, "packages", name.slice("@typed-sql/".length), "package.json"), "utf8"),
    );
    if (manifest.version !== release.series) {
      throw new Error(`${name} must rehearse as ${release.series}, received ${manifest.version}`);
    }
    versions[name] = manifest.version;
  }
  const prereleasePattern = new RegExp(`^${release.series.replaceAll(".", "\\.")}-(?:beta|rc)\\.\\d+$`, "u");
  for (const name of release.packagePolicy.experimental) {
    const manifest = JSON.parse(
      await readFile(join(workspace, "packages", name.slice("@typed-sql/".length), "package.json"), "utf8"),
    );
    if (!prereleasePattern.test(manifest.version)) {
      throw new Error(`${name} must remain prerelease, received ${manifest.version}`);
    }
    versions[name] = manifest.version;
  }
  return { release, versions };
}

async function packStablePackages(workspace, output, release, versions) {
  const tarballs = {};
  const dependencyRanges = {};
  await mkdir(output, { recursive: true });
  for (const name of release.packages) {
    const before = new Set(await readdir(output));
    await run("pnpm", ["--silent", "--filter", name, "pack", "--pack-destination", output], {
      cwd: workspace,
      label: `Packing ${name}`,
    });
    const archive = (await readdir(output)).find((file) => !before.has(file));
    if (archive === undefined) throw new Error(`No tarball produced for ${name}`);
    const tarball = join(output, archive);
    const packed = await run("tar", ["-xOf", tarball, "package/package.json"], { capture: true });
    const manifest = JSON.parse(packed.stdout);
    if (manifest.name !== name || manifest.version !== release.series) {
      throw new Error(`Packed ${manifest.name}@${manifest.version}, expected ${name}@${release.series}`);
    }
    for (const range of Object.values(manifest.dependencies ?? {})) {
      if (String(range).startsWith("workspace:")) throw new Error(`${name} packed an unresolved workspace range`);
    }
    const internalDependencies = Object.fromEntries(
      Object.entries(manifest.dependencies ?? {}).filter(([dependency]) => dependency.startsWith("@typed-sql/")),
    );
    for (const [dependency, range] of Object.entries(internalDependencies)) {
      const expected = versions[dependency];
      if (expected === undefined)
        throw new Error(`${name} depends on ${dependency}, which is outside the release policy`);
      if (range !== expected) throw new Error(`${name} packed ${dependency}@${range}, expected ${expected}`);
    }
    dependencyRanges[name] = internalDependencies;
    tarballs[name] = tarball;
  }
  return { tarballs, dependencyRanges };
}

async function installPackedGraph(directory, tarballs) {
  await mkdir(directory, { recursive: true });
  const dependencies = Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`]));
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies,
        pnpm: { overrides: dependencies },
      },
      null,
      2,
    )}\n`,
  );
  await run("pnpm", ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], {
    cwd: directory,
    label: "Installing rehearsed tarballs",
  });
  await writeFile(
    join(directory, "verify.mjs"),
    `
      import { createRequire } from "node:module";
      import { access } from "node:fs/promises";
      import { join } from "node:path";
      const require = createRequire(import.meta.url);
      const packages = ${JSON.stringify(Object.keys(tarballs).filter((name) => name !== "@typed-sql/cli"))};
      for (const name of packages) require.resolve(name);
      await access(join(process.cwd(), "node_modules/@typed-sql/cli/dist/packages/cli/src/cli.js"));
      for (const driver of ["pg", "mysql2"]) {
        try { require.resolve(driver); throw new Error(driver + " was installed implicitly"); }
        catch (error) { if (error.message.endsWith("was installed implicitly")) throw error; }
      }
    `,
  );
  await run(process.execPath, [join(directory, "verify.mjs")], { cwd: directory, label: "Resolving packed graph" });
}

export async function rehearseStableRelease(options = {}) {
  const workspace = options.workspace ?? defaultWorkspace;
  const artifactDirectory = options.artifactDirectory ?? join(workspace, "artifacts", "stable-rehearsal");
  const status = await run("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: workspace,
    capture: true,
  });
  if (status.stdout.trim() !== "") throw new Error("Stable rehearsal requires a clean tracked checkout");

  await rm(artifactDirectory, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "typed-sql-stable-rehearsal-"));
  const worktree = join(temporary, "worktree");
  let worktreeAdded = false;
  try {
    await run("git", ["worktree", "add", "--detach", worktree, "HEAD"], {
      cwd: workspace,
      label: "Creating isolated release worktree",
    });
    worktreeAdded = true;
    await run("pnpm", ["install", "--offline", "--ignore-scripts", "--frozen-lockfile"], {
      cwd: worktree,
      label: "Installing the isolated worktree",
    });
    await prepareStableVersion(worktree);
    const { release, versions } = await assertStableVersionState(worktree);
    await run(process.execPath, [join(worktree, "scripts", "assert-release-channel.mjs"), "stable"], {
      cwd: worktree,
      label: "Asserting the stable channel",
    });
    await run("pnpm", ["verify"], { cwd: worktree, label: "Running the stable verification suite" });
    await run("pnpm", ["e2e:packed"], {
      cwd: worktree,
      env: process.env,
      label: "Running packed real-database acceptance",
    });
    const { tarballs, dependencyRanges } = await packStablePackages(
      worktree,
      join(artifactDirectory, "packages"),
      release,
      versions,
    );
    await installPackedGraph(join(temporary, "consumer"), tarballs);
    const diff = await run("git", ["diff", "--binary", "--no-ext-diff"], { cwd: worktree, capture: true });
    if (diff.stdout.trim() === "") throw new Error("Stable rehearsal produced no version diff");
    await writeFile(join(artifactDirectory, "stable-release.diff"), diff.stdout);
    await writeFile(
      join(artifactDirectory, "report.json"),
      `${JSON.stringify(
        {
          channel: release.channel,
          npmTag: release.npmTag,
          series: release.series,
          sourceCandidate: release.sourceCandidate,
          versions,
          publicationOrder: release.packages,
          dependencyRanges,
          tarballs: Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [name, path.split("/").at(-1)])),
          registryWrites: 0,
          publicTagsCreated: 0,
        },
        null,
        2,
      )}\n`,
    );
    return artifactDirectory;
  } finally {
    if (worktreeAdded) {
      await run("git", ["worktree", "remove", "--force", worktree], {
        cwd: workspace,
        label: "Removing isolated release worktree",
      });
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const artifactDirectory = await rehearseStableRelease();
  process.stdout.write(`Stable rehearsal passed. Review ${artifactDirectory}/stable-release.diff and report.json\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
