import { execFile as callback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import {
  isPublishedOnNpm,
  loadExperimentalCompanionPlan,
  loadPrereleasePlan,
  loadReleasePlan,
  npmDistTags,
  type PrereleasePlan,
  publicationCommands,
  publishExperimentalCompanions as publishCompanionsWithNpm,
  publishPrerelease as publishPrereleaseWithNpm,
  publishRelease as publishReleaseWithNpm,
} from "../../scripts/publish-prerelease.mjs";
import { splitChangeset } from "../../scripts/rehearse-stable-release.mjs";
import { validateReleaseManifest } from "../../scripts/release-policy.mjs";
import { resolveStableRegistrySource } from "../../scripts/resolve-stable-registry-source.mjs";

const fakeTags = { getTags: async () => ({}), setTag: async () => undefined };
const publishRelease = (options: Parameters<typeof publishReleaseWithNpm>[0]) =>
  publishReleaseWithNpm({ ...fakeTags, ...options });
const publishPrerelease = (options: Parameters<typeof publishPrereleaseWithNpm>[0]) =>
  publishPrereleaseWithNpm({ ...fakeTags, ...options });
const publishExperimentalCompanions = (options: Parameters<typeof publishCompanionsWithNpm>[0]) =>
  publishCompanionsWithNpm({ ...fakeTags, ...options });

const plan: PrereleasePlan = {
  npmTag: "next",
  packages: [
    { name: "@typed-sql/core", version: "1.0.0-beta.1", directory: "/packages/core" },
    { name: "@typed-sql/ast", version: "1.0.0-beta.1", directory: "/packages/ast" },
    { name: "@typed-sql/schema", version: "1.0.0-beta.1", directory: "/packages/schema" },
  ],
};

await describe("prerelease publisher", async () => {
  await it("retries missing dist-tags without republishing or losing accepted writes", async () => {
    for (const acceptedBeforeFailure of [false, true]) {
      const pkg = { name: "@typed-sql/language-server", version: "2.2.0-rc.0", directory: "/packages/language-server" };
      const current: Record<string, string> = { latest: "1.0.0-beta.0" };
      let published = false;
      let publishes = 0;
      let gitTags = 0;
      let fail = true;
      const options = {
        channel: "stable" as const,
        plan: { npmTag: "next" as const, additionalTags: ["latest" as const], packages: [pkg] },
        isPublished: async () => published,
        getTags: async () => ({ ...current }),
        publishPackage: async () => {
          published = true;
          publishes += 1;
          current.next = pkg.version;
        },
        setTag: async (_pkg: typeof pkg, tag: string) => {
          if (fail) {
            if (acceptedBeforeFailure) current[tag] = pkg.version;
            fail = false;
            throw new Error("lost tag response");
          }
          current[tag] = pkg.version;
        },
        createTags: async () => {
          gitTags += 1;
        },
        log: () => undefined,
      };
      await strict.rejects(publishRelease(options), /lost tag response/u);
      strict.equal(gitTags, 0);
      await publishRelease(options);
      strict.equal(publishes, 1);
      strict.equal(gitTags, 1);
      strict.deepEqual(current, { latest: pkg.version, next: pkg.version });
    }
  });

  await it("never moves a newer tag backwards or publishes a stale missing version", async () => {
    let mutations = 0;
    const options = {
      plan: { npmTag: "next" as const, packages: [plan.packages[0]!] },
      getTags: async () => ({ next: "3.0.0" }),
      setTag: async () => {
        mutations += 1;
      },
      publishPackage: async () => {
        mutations += 1;
      },
      createTags: async () => undefined,
      log: () => undefined,
    };
    await publishRelease({ ...options, isPublished: async () => true });
    strict.equal(mutations, 0);
    await strict.rejects(publishRelease({ ...options, isPublished: async () => false }), /stale/u);
    strict.equal(mutations, 0);
    await strict.rejects(
      publishRelease({
        ...options,
        getTags: async () => {
          throw new Error("unavailable tags");
        },
      }),
      /unavailable tags/u,
    );
  });

  await it("reads tag state with bounded retries and refuses malformed or unauthorized responses", async () => {
    const statuses = [503, 200];
    strict.deepEqual(
      await npmDistTags("@typed-sql/core", {
        fetch: async () =>
          new Response(JSON.stringify({ "dist-tags": { latest: "2.1.0" } }), { status: statuses.shift()! }),
        wait: async () => undefined,
      }),
      { latest: "2.1.0" },
    );
    strict.deepEqual(
      await npmDistTags("@typed-sql/core", {
        fetch: async (url) => {
          strict.equal(url, "https://registry.npmjs.org/@typed-sql%2Fcore");
          return new Response(null, { status: 404 });
        },
      }),
      {},
    );
    await strict.rejects(
      npmDistTags("@typed-sql/core", { fetch: async () => new Response(null, { status: 403 }) }),
      /HTTP 403/u,
    );
    await strict.rejects(
      npmDistTags("@typed-sql/core", { fetch: async () => new Response(null, { status: 401 }) }),
      /HTTP 401/u,
    );
    await strict.rejects(
      npmDistTags("@typed-sql/core", { fetch: async () => new Response("{}") }),
      /Invalid npm dist-tags/u,
    );
    await strict.rejects(
      npmDistTags("@typed-sql/core", { fetch: async () => new Response('{"dist-tags":{"latest":"not-a-version"}}') }),
      /Invalid npm dist-tags/u,
    );
  });

  await it("enforces disjoint stable and experimental release tracks", () => {
    const stable = validateReleaseManifest({
      channel: "stable",
      series: "1.0.0",
      npmTag: "latest",
      sourceCandidate: "1.0.0-rc.0",
      packages: ["@typed-sql/core"],
      packagePolicy: {
        stable: ["@typed-sql/core"],
        experimental: ["@typed-sql/ts-bridge"],
      },
    });
    strict.deepStrictEqual(stable.packages, ["@typed-sql/core"]);
    strict.throws(
      () =>
        validateReleaseManifest({
          channel: "stable",
          series: "1.0.0",
          npmTag: "latest",
          sourceCandidate: "1.0.0-rc.0",
          packages: ["@typed-sql/core", "@typed-sql/ts-bridge"],
          packagePolicy: {
            stable: ["@typed-sql/core"],
            experimental: ["@typed-sql/ts-bridge"],
          },
        }),
      /stable release packages must match the stable package policy/u,
    );
    strict.throws(
      () =>
        validateReleaseManifest({
          channel: "beta",
          series: "1.0.0",
          npmTag: "next",
          packages: ["@typed-sql/core"],
          packagePolicy: {
            stable: ["@typed-sql/core"],
            experimental: ["@typed-sql/core"],
          },
        }),
      /Release tracks overlap/u,
    );
  });

  await it("retries transient registry failures but never guesses publication state", async () => {
    const statuses = [503, 200];
    const delays: number[] = [];
    const published = await isPublishedOnNpm("@typed-sql/core", "1.0.0-beta.1", {
      fetch: async () => new Response(undefined, { status: statuses.shift()! }),
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    strict.strictEqual(published, true);
    strict.deepStrictEqual(delays, [250]);

    await strict.rejects(
      isPublishedOnNpm("@typed-sql/core", "1.0.0-beta.1", {
        fetch: async () => new Response(undefined, { status: 403 }),
        wait: async () => undefined,
      }),
      /npm registry lookup failed/u,
    );
  });

  await it("packs with pnpm and publishes the resolved tarball through npm OIDC", () => {
    strict.deepStrictEqual(publicationCommands(plan.packages[0]!, "next", "/tmp/core.tgz"), [
      {
        command: "pnpm",
        args: ["pack", "--out", "/tmp/core.tgz"],
        cwd: "/packages/core",
      },
      {
        command: "npm",
        args: ["publish", "/tmp/core.tgz", "--access", "public", "--tag", "next", "--provenance"],
        cwd: "/packages/core",
      },
    ]);
  });

  await it("publishes missing packages in manifest order and tags only after success", async () => {
    const events: string[] = [];
    await publishPrerelease({
      plan,
      isPublished: async (name) => name === "@typed-sql/ast",
      publishPackage: async ({ name }, npmTag) => {
        events.push(`publish:${name}:${npmTag}`);
      },
      createTags: async () => {
        events.push("tags");
      },
      log: () => undefined,
    });
    strict.deepStrictEqual(events, ["publish:@typed-sql/core:next", "publish:@typed-sql/schema:next", "tags"]);
  });

  await it("does not create tags after a partial publish failure", async () => {
    const events: string[] = [];
    await strict.rejects(
      publishPrerelease({
        plan,
        isPublished: async () => false,
        publishPackage: async ({ name }) => {
          events.push(`publish:${name}`);
          if (name === "@typed-sql/ast") throw new Error("registry rejected package");
        },
        createTags: async () => {
          events.push("tags");
        },
        log: () => undefined,
      }),
      /registry rejected package/u,
    );
    strict.deepStrictEqual(events, ["publish:@typed-sql/core", "publish:@typed-sql/ast"]);
  });

  await it("retries safely after a failure at every package boundary", async () => {
    for (let failureIndex = 0; failureIndex < plan.packages.length; failureIndex += 1) {
      const published = new Set<string>();
      await strict.rejects(
        publishRelease({
          channel: "stable",
          plan: { ...plan, npmTag: "latest" },
          isPublished: async (name) => published.has(name),
          publishPackage: async ({ name }) => {
            published.add(name);
            if (name === plan.packages[failureIndex]?.name) throw new Error(`failure:${name}`);
          },
          createTags: async () => {
            throw new Error("tags must not be created after failure");
          },
          log: () => undefined,
        }),
        /failure:/u,
      );

      const retried: string[] = [];
      await publishRelease({
        channel: "stable",
        plan: { ...plan, npmTag: "latest" },
        isPublished: async (name) => published.has(name),
        publishPackage: async ({ name }) => {
          strict.ok(!published.has(name), `${name} would be republished`);
          published.add(name);
          retried.push(name);
        },
        createTags: async () => {
          retried.push("tags");
        },
        log: () => undefined,
      });
      strict.deepStrictEqual(retried, [...plan.packages.slice(failureIndex + 1).map(({ name }) => name), "tags"]);
    }
  });

  await it("retries tag creation without republishing a complete package train", async () => {
    const published = new Set<string>();
    await strict.rejects(
      publishRelease({
        channel: "stable",
        plan: { ...plan, npmTag: "latest" },
        isPublished: async (name) => published.has(name),
        publishPackage: async ({ name }) => {
          published.add(name);
        },
        createTags: async () => {
          throw new Error("tag failure");
        },
        log: () => undefined,
      }),
      /tag failure/u,
    );

    const events: string[] = [];
    await publishRelease({
      channel: "stable",
      plan: { ...plan, npmTag: "latest" },
      isPublished: async (name) => published.has(name),
      publishPackage: async ({ name }) => {
        events.push(`republished:${name}`);
      },
      createTags: async () => {
        events.push("tags");
      },
      log: () => undefined,
    });
    strict.deepStrictEqual(events, ["tags"]);
  });

  await it("reconciles experimental companions on next after an immutable stable train", async () => {
    const stablePlan = {
      npmTag: "latest" as const,
      packages: [{ name: "@typed-sql/core", version: "2.0.0", directory: "/packages/core" }],
    };
    const companionPlan: PrereleasePlan = {
      npmTag: "next",
      packages: [
        { name: "@typed-sql/ts-bridge", version: "2.0.0-rc.2", directory: "/packages/ts-bridge" },
        { name: "@typed-sql/sqlite", version: "2.0.0-rc.2", directory: "/packages/sqlite" },
      ],
    };
    const published = new Set(["@typed-sql/core@2.0.0"]);
    const firstRun: string[] = [];
    await strict.rejects(
      publishRelease({
        channel: "stable",
        plan: stablePlan,
        companionPlan,
        isPublished: async (name, version) => published.has(`${name}@${version}`),
        publishPackage: async ({ name, version }, npmTag) => {
          published.add(`${name}@${version}`);
          firstRun.push(`publish:${name}:${npmTag}`);
          if (name === "@typed-sql/sqlite") throw new Error("registry response lost after acceptance");
        },
        createTags: async () => {
          firstRun.push("tags");
        },
        log: () => undefined,
      }),
      /registry response lost/u,
    );
    strict.deepStrictEqual(firstRun, ["publish:@typed-sql/ts-bridge:next", "publish:@typed-sql/sqlite:next"]);

    const retry: string[] = [];
    await publishRelease({
      channel: "stable",
      plan: stablePlan,
      companionPlan,
      isPublished: async (name, version) => published.has(`${name}@${version}`),
      publishPackage: async ({ name }) => {
        retry.push(`republished:${name}`);
      },
      createTags: async () => {
        retry.push("tags");
      },
      log: () => undefined,
    });
    strict.deepStrictEqual(retry, ["tags"]);
  });

  await it("prepares companions without creating the unpublished stable train's Git tags", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-companion-tags-"));
    const execFile = promisify(callback);
    const events: string[] = [];
    const previousOutput = process.env.CHANGESETS_OUTPUT;
    try {
      await mkdir(join(temporary, ".changeset"));
      await writeFile(
        join(temporary, ".changeset/config.json"),
        JSON.stringify({
          changelog: false,
          commit: false,
          fixed: [],
          linked: [],
          access: "public",
          baseBranch: "main",
          updateInternalDependencies: "patch",
          ignore: [],
        }),
      );
      await writeFile(
        join(temporary, "package.json"),
        JSON.stringify({ name: "release-tag-fixture", private: true, packageManager: "pnpm@10.32.1" }),
      );
      await writeFile(join(temporary, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      for (const [name, version] of [
        ["core", "2.0.0"],
        ["ts-bridge", "2.0.0-rc.2"],
      ]) {
        await mkdir(join(temporary, "packages", name!), { recursive: true });
        await writeFile(
          join(temporary, "packages", name!, "package.json"),
          JSON.stringify({ name: `@typed-sql/${name}`, version }),
        );
      }
      for (const args of [
        ["init", "-b", "main"],
        ["config", "user.name", "Release fixture"],
        ["config", "user.email", "fixture@example.invalid"],
        ["add", "."],
        ["commit", "-m", "Fixture"],
      ])
        await execFile("git", args, { cwd: temporary });
      await publishExperimentalCompanions({
        workspace: temporary,
        plan: {
          npmTag: "next",
          packages: [
            { name: "@typed-sql/ts-bridge", version: "2.0.0-rc.2", directory: join(temporary, "packages/ts-bridge") },
          ],
        },
        isPublished: async () => false,
        publishPackage: async ({ name }, npmTag) => {
          events.push(`publish:${name}:${npmTag}`);
        },
        log: () => undefined,
      });
      strict.deepStrictEqual(events, ["publish:@typed-sql/ts-bridge:next"]);
      strict.equal((await execFile("git", ["tag", "--list"], { cwd: temporary })).stdout, "");
      // The complete publisher still creates tags and emits the events that the
      // pinned Changesets action needs to push tags and create GitHub releases.
      const output = join(temporary, "changesets-output.ndjson");
      process.env.CHANGESETS_OUTPUT = output;
      await publishRelease({
        workspace: temporary,
        channel: "stable",
        plan: {
          npmTag: "latest",
          packages: [{ name: "@typed-sql/core", version: "2.0.0", directory: join(temporary, "packages/core") }],
        },
        isPublished: async () => false,
        publishPackage: async () => undefined,
        log: () => undefined,
      });
      const tags = (await execFile("git", ["tag", "--list"], { cwd: temporary })).stdout;
      strict.ok(tags.includes("@typed-sql/core@2.0.0"));
      const reported = (await readFile(output, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      strict.ok(reported.some((event) => event.type === "git-tag" && event.tag === "@typed-sql/core@2.0.0"));
    } finally {
      if (previousOutput === undefined) delete process.env.CHANGESETS_OUTPUT;
      else process.env.CHANGESETS_OUTPUT = previousOutput;
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("selects one coherent stable registry graph for fresh and resumed releases", async () => {
    const stablePlan = {
      npmTag: "latest" as const,
      packages: [
        { name: "@typed-sql/core", version: "2.0.0", directory: "/packages/core" },
        { name: "@typed-sql/schema", version: "2.0.0", directory: "/packages/schema" },
      ],
    };

    strict.deepStrictEqual(
      await resolveStableRegistrySource({
        plan: stablePlan,
        isPublished: async (name) => name === "@typed-sql/core",
      }),
      { tag: "next", expected: undefined },
    );
    strict.deepStrictEqual(
      await resolveStableRegistrySource({
        plan: stablePlan,
        isPublished: async () => true,
      }),
      { tag: "latest", expected: "workspace" },
    );
  });

  await it("splits mixed Changesets without losing experimental release notes", () => {
    const split = splitChangeset(
      `---\n"@typed-sql/core": patch\n"@typed-sql/ts-bridge": patch\n---\n\nDescribe the shared change.\n`,
      new Set(["@typed-sql/ts-bridge"]),
    );
    strict.strictEqual(split.stable, `---\n"@typed-sql/core": patch\n---\n\nDescribe the shared change.\n`);
    strict.strictEqual(split.experimental, `---\n"@typed-sql/ts-bridge": patch\n---\n\nDescribe the shared change.\n`);
  });

  await it("loads independently versioned packages in the declared graph", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-publish-"));
    try {
      await writeFile(
        join(temporary, "release-manifest.json"),
        JSON.stringify({
          channel: "beta",
          series: "1.0.0",
          npmTag: "next",
          packages: ["@typed-sql/core", "@typed-sql/ast"],
          packagePolicy: {
            stable: ["@typed-sql/core", "@typed-sql/ast"],
            experimental: [],
          },
        }),
      );
      for (const [name, version] of [
        ["core", "1.0.0-beta.1"],
        ["ast", "1.0.0-beta.2"],
      ] as const) {
        const directory = join(temporary, "packages", name);
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "package.json"),
          JSON.stringify({
            name: `@typed-sql/${name}`,
            version,
          }),
        );
      }
      strict.deepStrictEqual(await loadPrereleasePlan(temporary), {
        npmTag: "next",
        packages: [
          { name: "@typed-sql/core", version: "1.0.0-beta.1", directory: join(temporary, "packages", "core") },
          { name: "@typed-sql/ast", version: "1.0.0-beta.2", directory: join(temporary, "packages", "ast") },
        ],
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("rejects a channel or version mismatch before contacting npm", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-publish-"));
    try {
      await writeFile(
        join(temporary, "release-manifest.json"),
        JSON.stringify({
          channel: "beta",
          series: "1.0.0",
          npmTag: "beta",
          packages: ["@typed-sql/core"],
          packagePolicy: {
            stable: ["@typed-sql/core"],
            experimental: [],
          },
        }),
      );
      await strict.rejects(loadPrereleasePlan(temporary), /beta releases must use the next npm tag/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("loads only the declared stable train in manifest order", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-stable-publish-"));
    try {
      await writeFile(
        join(temporary, "release-manifest.json"),
        JSON.stringify({
          channel: "stable",
          series: "1.0.0",
          npmTag: "latest",
          sourceCandidate: "1.0.0-rc.0",
          packages: ["@typed-sql/core"],
          packagePolicy: {
            stable: ["@typed-sql/core"],
            experimental: ["@typed-sql/ts-bridge"],
          },
        }),
      );
      for (const [name, version, track] of [
        ["core", "1.0.0", "stable"],
        ["ts-bridge", "1.0.0-beta.3", "experimental"],
      ] as const) {
        const directory = join(temporary, "packages", name);
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "package.json"),
          JSON.stringify({ name: `@typed-sql/${name}`, version, typedSql: { releaseTrack: track } }),
        );
      }
      strict.deepStrictEqual(await loadReleasePlan("stable", temporary), {
        npmTag: "latest",
        packages: [{ name: "@typed-sql/core", version: "1.0.0", directory: join(temporary, "packages", "core") }],
      });
      strict.deepStrictEqual(await loadExperimentalCompanionPlan(temporary), {
        npmTag: "next",
        additionalTags: ["latest"],
        packages: [
          {
            name: "@typed-sql/ts-bridge",
            version: "1.0.0-beta.3",
            directory: join(temporary, "packages", "ts-bridge"),
          },
        ],
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
