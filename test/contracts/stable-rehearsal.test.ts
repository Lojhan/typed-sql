import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

await describe("stable release rehearsal policy", async () => {
  await it("keeps rehearsal incapable of registry or public git writes", async () => {
    const source = await readFile(resolve(workspace, "scripts/rehearse-stable-release.mjs"), "utf8");

    for (const forbidden of ["npm publish", '"publish"', '"git-tag"', '"tag", "-a"', '"push"']) {
      strict.ok(!source.includes(forbidden), `rehearsal contains forbidden write primitive: ${forbidden}`);
    }
    for (const required of [
      '"worktree", "add", "--detach"',
      '"worktree", "remove", "--force"',
      'changesetsCli, "pre", "exit"',
      'changesetsCli, "version"',
      'release.channel !== "rc"',
      "sourceCandidate",
      '"release-manifest.json"',
      '"verify"',
      '"e2e:packed"',
      '"stable-release.diff"',
      "dependencyRanges",
      "registryWrites: 0",
      "publicTagsCreated: 0",
    ]) {
      strict.ok(source.includes(required), `rehearsal lost required contract: ${required}`);
    }
  });

  await it("requires protected main and npm OIDC before stable publication", async () => {
    const workflow = await readFile(resolve(workspace, ".github/workflows/release.yml"), "utf8");
    const publish = workflow.slice(workflow.indexOf("  publish:"));

    strict.ok(publish.includes("github.ref == 'refs/heads/main'"));
    strict.ok(publish.includes("environment: npm"));
    strict.ok(publish.includes("id-token: write"));
    strict.ok(publish.includes("package-manager-cache: false"));
    strict.ok(publish.includes("npm install --global npm@12.0.2"));
    strict.ok(publish.includes("script: pnpm release:stable"));
  });

  await it("routes stable publication through the retry-safe publisher", async () => {
    const manifest = JSON.parse(await readFile(resolve(workspace, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    strict.strictEqual(manifest.scripts["release:rehearse"], "node scripts/rehearse-stable-release.mjs");
    strict.strictEqual(
      manifest.scripts["release:stable"],
      "pnpm release:assert stable && node scripts/publish-prerelease.mjs stable",
    );
    strict.ok(!manifest.scripts["release:stable"]?.includes("changeset publish"));
  });
});
