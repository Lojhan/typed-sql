import { describe, it, strict } from "poku";
import { assertMarketplaceManifest, verifyComprehensiveCiRun } from "../../scripts/editor-marketplace.mjs";

await describe("editor marketplace publication policy", async () => {
  await it("authenticates comprehensive CI metadata for editor and npm publication", async () => {
    const id = "12345";
    const sha = "a".repeat(40);
    const run = {
      id: Number(id),
      repository: { full_name: "Lojhan/typed-sql" },
      path: ".github/workflows/ci.yml",
      head_branch: "main",
      head_sha: sha,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
    };
    const verify = (metadata: unknown) =>
      verifyComprehensiveCiRun({
        id,
        sha,
        token: "fixture-token",
        fetchRun: async (url, init) => {
          strict.equal(url, "https://api.github.com/repos/Lojhan/typed-sql/actions/runs/12345");
          strict.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-token");
          return Response.json(metadata);
        },
      });
    await verify(run);
    for (const change of [
      { id: 54321 },
      { head_sha: "b".repeat(40) },
      { head_branch: "feature" },
      { event: "pull_request" },
      { event: "push" },
      { conclusion: "failure" },
      { conclusion: "cancelled" },
      { conclusion: null },
      { status: "in_progress" },
      { repository: { full_name: "someone/fork" } },
      { path: ".github/workflows/unrelated.yml" },
    ])
      await strict.rejects(verify({ ...run, ...change }), /successful comprehensive CI/u);
    await strict.rejects(verify(null), /successful comprehensive CI/u);
  });

  await it("rejects malformed identifiers before sending a request and refuses API failures", async () => {
    const sha = "a".repeat(40);
    let requests = 0;
    const fetchRun: typeof fetch = async () => {
      requests += 1;
      return new Response("not authorized", { status: 403 });
    };
    for (const id of [undefined, "", "0", "../12345", "12345?other=1"])
      await strict.rejects(
        verifyComprehensiveCiRun({ id, sha, token: "fixture-token", fetchRun }),
        /Invalid CI evidence/u,
      );
    for (const invalid of [undefined, "", "a".repeat(39), "g".repeat(40)])
      await strict.rejects(
        verifyComprehensiveCiRun({ id: "12345", sha: invalid, token: "fixture-token", fetchRun }),
        /Invalid CI evidence/u,
      );
    strict.equal(requests, 0);
    await strict.rejects(
      verifyComprehensiveCiRun({ id: "12345", sha, token: "fixture-token", fetchRun }),
      /Could not read CI evidence \(403\)/u,
    );
    strict.equal(requests, 1);
    await strict.rejects(
      verifyComprehensiveCiRun({
        id: "12345",
        sha,
        token: "fixture-token",
        fetchRun: async () => new Response("invalid JSON"),
      }),
      SyntaxError,
    );
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
