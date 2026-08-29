import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, strict } from "poku";
import { detectPendingChangesets } from "../../scripts/detect-pending-changesets.mjs";
import { type ReleaseManifest, validateReleaseManifest } from "../../scripts/release-policy.mjs";
import {
  nextReleaseCandidateNumber,
  normalizeReleaseCandidateVersions,
  versionPackages,
} from "../../scripts/version-packages.mjs";

const workspace = resolve(import.meta.dirname, "../..");

const rcRelease: ReleaseManifest = {
  channel: "rc",
  series: "1.0.0",
  npmTag: "next",
  packages: ["@typed-sql/core", "@typed-sql/compiler"],
  packagePolicy: {
    stable: ["@typed-sql/core", "@typed-sql/compiler"],
    experimental: [],
  },
};

await describe("release-candidate policy", async () => {
  await it("accepts only a complete RC train on npm next", () => {
    strict.strictEqual(validateReleaseManifest(rcRelease).channel, "rc");
    strict.throws(() => validateReleaseManifest({ ...rcRelease, npmTag: "latest" }), /must use the next npm tag/u);
    strict.throws(
      () => validateReleaseManifest({ ...rcRelease, packages: ["@typed-sql/core"] }),
      /complete prerelease package policy/u,
    );
    strict.throws(
      () => validateReleaseManifest({ ...rcRelease, sourceCandidate: "1.0.0-rc.0" }),
      /only valid for stable releases/u,
    );
  });

  await it("increments a coherent candidate counter without inheriting beta numbers", () => {
    strict.strictEqual(nextReleaseCandidateNumber(["1.0.0-beta.9", "1.0.0-beta.11"], "1.0.0"), 0);
    strict.strictEqual(nextReleaseCandidateNumber(["1.0.0-rc.0", "1.0.0-beta.11"], "1.0.0"), 1);
    strict.strictEqual(nextReleaseCandidateNumber(["1.0.0-rc.3", "1.0.0-rc.1"], "1.0.0"), 4);
  });

  await it("normalizes changed and unchanged packages into one RC version", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-rc-version-"));
    try {
      const fixtures = [
        {
          directory: "core",
          version: "1.0.0-rc.3",
          changelog:
            "# @typed-sql/core\n\n## 1.0.0-rc.3\n\n### Patch Changes\n\n- Updated @typed-sql/compiler@1.0.0-rc.2.\n\n## 1.0.0-beta.2\n\n- Historical reference to 1.0.0-rc.3.\n",
        },
        {
          directory: "compiler",
          version: "1.1.0-rc.0",
          changelog: "# @typed-sql/compiler\n\n## 1.1.0-rc.0\n\n- History.\n",
        },
      ] as const;
      for (const fixture of fixtures) {
        const directory = join(temporary, "packages", fixture.directory);
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "package.json"),
          `${JSON.stringify({ name: `@typed-sql/${fixture.directory}`, version: fixture.version }, null, 2)}\n`,
        );
        await writeFile(join(directory, "CHANGELOG.md"), fixture.changelog);
      }

      const target = await normalizeReleaseCandidateVersions(
        temporary,
        rcRelease,
        new Map([
          ["@typed-sql/core", "1.0.0-beta.2"],
          ["@typed-sql/compiler", "1.0.0"],
        ]),
        0,
      );
      strict.strictEqual(target, "1.0.0-rc.0");
      for (const fixture of fixtures) {
        const manifest = JSON.parse(
          await readFile(join(temporary, "packages", fixture.directory, "package.json"), "utf8"),
        );
        strict.strictEqual(manifest.version, target);
        const changelog = await readFile(join(temporary, "packages", fixture.directory, "CHANGELOG.md"), "utf8");
        strict.ok(changelog.includes("## 1.0.0-rc.0\n"));
        if (fixture.directory === "core") {
          strict.ok(changelog.includes("## 1.0.0-beta.2\n"), "historical beta notes must remain unchanged");
          strict.ok(changelog.includes("Updated @typed-sql/compiler@1.0.0-rc.0."));
          strict.ok(changelog.includes("Historical reference to 1.0.0-rc.3."));
        }
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("runs Changesets first and refreshes the lockfile after RC normalization", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-rc-orchestration-"));
    try {
      await mkdir(join(temporary, ".changeset"), { recursive: true });
      await writeFile(join(temporary, "release-manifest.json"), JSON.stringify(rcRelease));
      await writeFile(join(temporary, ".changeset", "pre.json"), JSON.stringify({ mode: "pre", tag: "rc" }));
      for (const directoryName of ["core", "compiler"]) {
        const directory = join(temporary, "packages", directoryName);
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "package.json"),
          JSON.stringify({ name: `@typed-sql/${directoryName}`, version: "1.0.0-beta.2" }),
        );
        await writeFile(join(directory, "CHANGELOG.md"), `# @typed-sql/${directoryName}\n`);
      }

      const commands: string[] = [];
      const target = await versionPackages({
        workspace: temporary,
        runCommand: async (command, args) => {
          commands.push(`${command}:${args.join(" ")}`);
          if (args.at(-1) === "version") {
            const core = join(temporary, "packages", "core");
            await writeFile(
              join(core, "package.json"),
              JSON.stringify({ name: "@typed-sql/core", version: "1.0.0-rc.7" }),
            );
            await writeFile(join(core, "CHANGELOG.md"), "# @typed-sql/core\n\n## 1.0.0-rc.7\n\n- Fix.\n");
          }
        },
      });

      strict.strictEqual(target, "1.0.0-rc.0");
      strict.strictEqual(commands.length, 2);
      strict.ok(commands[0]?.endsWith(" version"));
      strict.ok(commands[1]?.includes("pnpm:install --lockfile-only --offline --ignore-scripts"));
      for (const directoryName of ["core", "compiler"]) {
        const manifest = JSON.parse(await readFile(join(temporary, "packages", directoryName, "package.json"), "utf8"));
        strict.strictEqual(manifest.version, target);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("keeps RC publication and registry-only stable proof in workflow order", async () => {
    const workflow = await readFile(join(workspace, ".github", "workflows", "release.yml"), "utf8");
    strict.ok(workflow.includes("          - rc"));
    const assertRc = workflow.indexOf("run: pnpm release:assert rc");
    const publishRc = workflow.indexOf("script: pnpm release:rc");
    const verifyPublished = workflow.indexOf("name: Verify published prerelease from npm");
    strict.ok(assertRc > 0 && publishRc > assertRc && verifyPublished > publishRc);
    const verifyRegistryCandidate = workflow.indexOf("name: Verify registry-only release candidate");
    const assertStable = workflow.indexOf("run: pnpm release:assert stable");
    const publishCompanions = workflow.indexOf("name: Publish experimental companions");
    const publishStable = workflow.indexOf("script: pnpm release:stable");
    strict.ok(
      assertStable > 0 &&
        publishCompanions > assertStable &&
        verifyRegistryCandidate > publishCompanions &&
        publishStable > verifyRegistryCandidate,
    );
    strict.ok(workflow.includes('node scripts/detect-pending-changesets.mjs >> "$GITHUB_OUTPUT"'));
  });

  await it("distinguishes new changesets from prerelease files already consumed", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-pending-changesets-"));
    try {
      const directory = join(temporary, ".changeset");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "README.md"), "# Changesets\n");
      await writeFile(join(directory, "consumed.md"), "---\n---\nConsumed.\n");
      await writeFile(join(directory, "new-change.md"), "---\n---\nNew.\n");

      strict.deepStrictEqual(await detectPendingChangesets(temporary), ["consumed", "new-change"]);
      await writeFile(join(directory, "pre.json"), JSON.stringify({ mode: "pre", tag: "rc" }));
      strict.deepStrictEqual(await detectPendingChangesets(temporary), ["consumed", "new-change"]);
      await writeFile(
        join(directory, "pre.json"),
        JSON.stringify({ mode: "pre", tag: "rc", changesets: ["consumed"] }),
      );
      strict.deepStrictEqual(await detectPendingChangesets(temporary), ["new-change"]);
      await writeFile(
        join(directory, "pre.json"),
        JSON.stringify({ mode: "pre", tag: "rc", changesets: ["consumed", "new-change"] }),
      );
      strict.deepStrictEqual(await detectPendingChangesets(temporary), []);
      await writeFile(join(directory, "pre.json"), JSON.stringify({ mode: "exit", tag: "rc", changesets: [] }));
      strict.deepStrictEqual(await detectPendingChangesets(temporary), ["prerelease-exit"]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
