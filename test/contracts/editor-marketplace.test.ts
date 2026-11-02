import { describe, it, strict } from "poku";
import {
  assertMarketplaceManifest,
  verifyComprehensiveCiRun,
  verifyMarketplaceArtifactSource,
} from "../../scripts/editor-marketplace.mjs";

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

  await it("reuses a successful artifact from a partial publication only with authenticated source evidence", async () => {
    const source = "b".repeat(40);
    const run = {
      id: 12345,
      repository: { full_name: "Lojhan/typed-sql" },
      path: ".github/workflows/editor-marketplaces.yml",
      head_branch: "main",
      head_sha: source,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
    };
    const ci = { ...run, id: 67890, path: ".github/workflows/ci.yml", conclusion: "success" };
    const artifactJob = { name: "artifact", status: "completed", conclusion: "success" };
    const fixtures = {
      run,
      jobs: { jobs: [artifactJob, { name: "visual-studio-marketplace", conclusion: "failure" }] },
      comparison: { status: "ahead" },
      evidence: { workflow_runs: [ci] },
    };
    const verify = (changes: Partial<Record<keyof typeof fixtures, unknown>> = {}) =>
      verifyMarketplaceArtifactSource({
        id: "12345",
        sha: "a".repeat(40),
        token: "fixture-token",
        fetchRun: async (url, init) => {
          strict.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-token");
          const routes = {
            "https://api.github.com/repos/Lojhan/typed-sql/actions/runs/12345": "run",
            "https://api.github.com/repos/Lojhan/typed-sql/actions/runs/12345/jobs?per_page=100": "jobs",
            [`https://api.github.com/repos/Lojhan/typed-sql/compare/${source}...${"a".repeat(40)}`]: "comparison",
            [`https://api.github.com/repos/Lojhan/typed-sql/actions/workflows/ci.yml/runs?event=workflow_dispatch&status=success&head_sha=${source}&per_page=100`]:
              "evidence",
          } as const;
          const key = routes[String(url) as keyof typeof routes];
          if (key === undefined) throw new Error(`unexpected API request ${url}`);
          return Response.json({ ...fixtures, ...changes }[key]);
        },
      });
    strict.equal(await verify(), source);
    strict.equal(await verify({ comparison: { status: "identical" } }), source);
    for (const change of [
      { id: 99999 },
      { repository: { full_name: "someone/fork" } },
      { path: ".github/workflows/ci.yml" },
      { head_branch: "feature" },
      { event: "pull_request" },
      { status: "in_progress" },
      { head_sha: "not-a-commit" },
    ])
      await strict.rejects(verify({ run: { ...run, ...change } }), /completed marketplace workflow on main/u);
    for (const jobs of [[], [{ ...artifactJob, conclusion: "failure" }], [artifactJob, artifactJob]])
      await strict.rejects(verify({ jobs: { jobs } }), /successful artifact job/u);
    for (const status of ["behind", "diverged"]) await strict.rejects(verify({ comparison: { status } }), /ancestor/u);
    for (const workflow_runs of [[], [{ ...ci, id: undefined }], [{ ...ci, conclusion: "failure" }]])
      await strict.rejects(verify({ evidence: { workflow_runs } }), /successful comprehensive CI/u);
    let requested = false;
    for (const id of ["", "0", "../12345", "12345?other=1"])
      await strict.rejects(
        verifyMarketplaceArtifactSource({
          id,
          sha: "a".repeat(40),
          token: "fixture-token",
          fetchRun: async () => {
            requested = true;
            return Response.json(run);
          },
        }),
        /Invalid marketplace artifact/u,
      );
    strict.equal(requested, false);
  });
});
