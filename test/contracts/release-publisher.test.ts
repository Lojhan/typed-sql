import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  isPublishedOnNpm,
  loadPrereleasePlan,
  publicationCommands,
  publishPrerelease,
  type PrereleasePlan,
} from "../../scripts/publish-prerelease.mjs";

const plan: PrereleasePlan = {
  npmTag: "next",
  packages: [
    { name: "@typed-sql/core", version: "1.0.0-beta.1", directory: "/packages/core" },
    { name: "@typed-sql/ast", version: "1.0.0-beta.1", directory: "/packages/ast" },
    { name: "@typed-sql/schema", version: "1.0.0-beta.1", directory: "/packages/schema" },
  ],
};

await describe("prerelease publisher", async () => {
  await it("retries transient registry failures but never guesses publication state", async () => {
    const statuses = [503, 200];
    const delays: number[] = [];
    const published = await isPublishedOnNpm("@typed-sql/core", "1.0.0-beta.1", {
      fetch: async () => new Response(undefined, { status: statuses.shift()! }),
      wait: async (milliseconds) => { delays.push(milliseconds); },
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
        args: ["publish", "/tmp/core.tgz", "--access", "public", "--tag", "next"],
        cwd: "/packages/core",
      },
    ]);
  });

  await it("publishes missing packages in manifest order and tags only after success", async () => {
    const events: string[] = [];
    await publishPrerelease({
      plan,
      isPublished: async (name) => name === "@typed-sql/ast",
      publishPackage: async ({ name }, npmTag) => { events.push(`publish:${name}:${npmTag}`); },
      createTags: async () => { events.push("tags"); },
      log: () => undefined,
    });
    strict.deepStrictEqual(events, [
      "publish:@typed-sql/core:next",
      "publish:@typed-sql/schema:next",
      "tags",
    ]);
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
        createTags: async () => { events.push("tags"); },
        log: () => undefined,
      }),
      /registry rejected package/u,
    );
    strict.deepStrictEqual(events, ["publish:@typed-sql/core", "publish:@typed-sql/ast"]);
  });

  await it("loads independently versioned packages in the declared graph", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-publish-"));
    try {
      await writeFile(join(temporary, "release-manifest.json"), JSON.stringify({
        channel: "beta",
        series: "1.0.0",
        npmTag: "next",
        packages: ["@typed-sql/core", "@typed-sql/ast"],
      }));
      for (const [name, version] of [["core", "1.0.0-beta.1"], ["ast", "1.0.0-beta.2"]] as const) {
        const directory = join(temporary, "packages", name);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "package.json"), JSON.stringify({
          name: `@typed-sql/${name}`,
          version,
        }));
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
      await writeFile(join(temporary, "release-manifest.json"), JSON.stringify({
        channel: "beta",
        series: "1.0.0",
        npmTag: "beta",
        packages: ["@typed-sql/core"],
      }));
      await strict.rejects(loadPrereleasePlan(temporary), /Expected beta versions on npm next/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
