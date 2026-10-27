import { describe, it, strict } from "poku";
import { assertMarketplaceEvidence, assertMarketplaceManifest } from "../../scripts/editor-marketplace.mjs";

await describe("editor marketplace publication policy", async () => {
  await it("requires complete comprehensive evidence for the exact main commit", () => {
    const sha = "a".repeat(40);
    const run = {
      repository: { full_name: "Lojhan/typed-sql" },
      path: ".github/workflows/ci.yml",
      head_branch: "main",
      head_sha: sha,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
    };
    assertMarketplaceEvidence(run, sha);
    for (const change of [
      { head_sha: "b".repeat(40) },
      { head_branch: "feature" },
      { event: "pull_request" },
      { conclusion: "failure" },
      { status: "in_progress" },
      { repository: { full_name: "someone/fork" } },
      { path: ".github/workflows/unrelated.yml" },
    ])
      strict.throws(() => assertMarketplaceEvidence({ ...run, ...change }, sha));
  });
  await it("refuses another publisher or a stable marketplace artifact", () => {
    const manifest = { publisher: "lojhan", name: "typed-sql", version: "0.1.0" };
    const xml = '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />';
    assertMarketplaceManifest(manifest, xml);
    for (const change of [{ publisher: "other" }, { name: "other" }, { version: "1.0.0" }])
      strict.throws(() => assertMarketplaceManifest({ ...manifest, ...change }, xml));
    strict.throws(() => assertMarketplaceManifest(manifest, xml.replace('Value="true"', 'Value="false"')));
  });
});
