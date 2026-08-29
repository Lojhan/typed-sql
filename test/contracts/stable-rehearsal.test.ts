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
    const publisher = await readFile(resolve(workspace, "scripts/publish-prerelease.mjs"), "utf8");
    strict.ok(publisher.includes("loadExperimentalCompanionPlan"));
    strict.ok(publisher.includes('return { npmTag: "next", packages }'));
  });

  await it("publishes durable release notes with the supported and experimental boundaries", async () => {
    const notes = await readFile(resolve(workspace, ".github/release-notes/2.0.0.md"), "utf8");
    const normalizedNotes = notes.replaceAll(/\s+/gu, " ");
    for (const required of [
      "https://lojhan.github.io/typed-sql/guides/upgrading-from-v1",
      "https://lojhan.github.io/typed-sql/reference/compatibility",
      "Node.js 22.11 or newer",
      "TypeScript 7.0.2",
      "PostgreSQL and MySQL are stable dialect packages",
      "@typed-sql/ts-bridge",
      "@typed-sql/language-server",
      "@typed-sql/sqlite",
      "remain experimental",
    ]) {
      strict.ok(normalizedNotes.includes(required), `stable release notes lost required boundary: ${required}`);
    }

    const workflow = await readFile(resolve(workspace, ".github/workflows/release.yml"), "utf8");
    const publishStable = workflow.indexOf("name: Publish stable");
    const publishNotes = workflow.indexOf("name: Publish aggregate stable release notes");
    const verifyRegistry = workflow.indexOf("name: Verify published stable packages from npm");
    strict.ok(publishStable > 0 && verifyRegistry > publishStable && publishNotes > verifyRegistry);
    strict.ok(workflow.includes('notes_file=".github/release-notes/${release_series}.md"'));
    strict.ok(workflow.includes('gh release view "${release_tag}"'));
    strict.ok(workflow.includes('gh release create "${release_tag}"'));
  });

  await it("documents a non-destructive and retry-safe recovery procedure", async () => {
    const guide = await readFile(resolve(workspace, "CONTRIBUTING.md"), "utf8");
    for (const required of [
      "Release publication is append-only.",
      "publisher is safe to retry on the same commit",
      "npm dist-tag add <package>@<known-good-version> latest",
      "Poku release-publisher contract simulates failure and retry at every package boundary",
      "pnpm release:rehearse",
    ]) {
      strict.ok(guide.includes(required), `release recovery guide lost required contract: ${required}`);
    }
    for (const forbidden of ["npm unpublish", "npm dist-tag rm", "git push --force", "git reset --hard"]) {
      strict.ok(!guide.includes(forbidden), `release recovery guide suggests destructive command: ${forbidden}`);
    }
  });
});
