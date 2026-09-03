import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it, strict } from "poku";

const workspace = resolve(import.meta.dirname, "../..");

await describe("release artifact integrity and provenance", async () => {
  await it("verifies rebuilt contents, declarations, source maps, licenses, and sensitive-file absence", async () => {
    const verifier = await readFile(join(workspace, "scripts/verify-release-artifacts.mjs"), "utf8");
    for (const evidence of [
      "contentSha256",
      "sha512",
      "byte-identical",
      "content-identical-normalized-package-metadata",
      "has no declaration",
      "has no execute permission",
      "contains an absolute source",
      "forbidden development or sensitive file",
      "has no LICENSE",
      "oidcProvenance: true",
    ]) {
      strict.ok(verifier.includes(evidence), `release artifact verifier lost ${evidence}`);
    }
  });

  await it("blocks publication on artifact verification and retains its evidence", async () => {
    const manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    strict.ok(manifest.scripts["release:artifacts"]?.includes("verify-release-artifacts.mjs"));
    const workflow = await readFile(join(workspace, ".github/workflows/release.yml"), "utf8");
    const verify = workflow.indexOf("run: pnpm release:artifacts");
    const publish = workflow.indexOf("name: Publish beta");
    strict.ok(verify > 0 && publish > verify);
    strict.ok(workflow.includes("retention-days: 90"));
    const publisher = await readFile(join(workspace, "scripts/publish-prerelease.mjs"), "utf8");
    strict.ok(publisher.includes('"--provenance"'));
  });
});
