import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  isPublishedOnNpm,
  loadExperimentalCompanionPlan,
  loadPrereleasePlan,
  loadReleasePlan,
  type PrereleasePlan,
  publicationCommands,
  publishExperimentalCompanions,
  publishPrerelease,
  publishRelease,
} from "../../scripts/publish-prerelease.mjs";
import { splitChangeset } from "../../scripts/rehearse-stable-release.mjs";
import { validateReleaseManifest } from "../../scripts/release-policy.mjs";
import { resolveStableRegistrySource } from "../../scripts/resolve-stable-registry-source.mjs";

const plan: PrereleasePlan = {
  npmTag: "next",
  packages: [
    { name: "@typed-sql/core", version: "1.0.0-beta.1", directory: "/packages/core" },
    { name: "@typed-sql/ast", version: "1.0.0-beta.1", directory: "/packages/ast" },
    { name: "@typed-sql/schema", version: "1.0.0-beta.1", directory: "/packages/schema" },
  ],
};

await describe("prerelease publisher", async () => {
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

  await it("publishes the companion plan independently before registry acceptance", async () => {
    const events: string[] = [];
    await publishExperimentalCompanions({
      plan: {
        npmTag: "next",
        packages: [{ name: "@typed-sql/sqlite", version: "2.0.0-rc.2", directory: "/packages/sqlite" }],
      },
      isPublished: async () => false,
      publishPackage: async ({ name }, npmTag) => {
        events.push(`publish:${name}:${npmTag}`);
      },
      createTags: async () => {
        events.push("tags");
      },
      log: () => undefined,
    });
    strict.deepStrictEqual(events, ["publish:@typed-sql/sqlite:next", "tags"]);
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
