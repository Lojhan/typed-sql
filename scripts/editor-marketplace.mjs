import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(callback);
const repositoryApi = "https://api.github.com/repos/Lojhan/typed-sql";

async function githubJson(path, token, fetchRun, label) {
  const response = await fetchRun(`${repositoryApi}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not read ${label} (${response.status})`);
  return response.json();
}

function assertComprehensiveCiRun(run, id, sha) {
  if (
    typeof run !== "object" ||
    run === null ||
    String(run.id) !== id ||
    run.repository?.full_name !== "Lojhan/typed-sql" ||
    run.path !== ".github/workflows/ci.yml" ||
    run.head_branch !== "main" ||
    run.head_sha !== sha ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw new Error("Publication requires successful comprehensive CI for the exact main commit");
}

export async function verifyComprehensiveCiRun({ id, sha, token, fetchRun = fetch }) {
  if (typeof id !== "string" || !/^[1-9]\d*$/u.test(id) || typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha))
    throw new Error("Invalid CI evidence run or source commit");
  assertComprehensiveCiRun(await githubJson(`/actions/runs/${id}`, token, fetchRun, "CI evidence"), id, sha);
}

/** A partial registry failure must retry the original bytes, not rebuild a published version. */
export async function verifyMarketplaceArtifactSource({ id, sha, token, fetchRun = fetch }) {
  if (typeof id !== "string" || !/^[1-9]\d*$/u.test(id) || typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha))
    throw new Error("Invalid marketplace artifact run or current commit");
  const run = await githubJson(`/actions/runs/${id}`, token, fetchRun, "marketplace artifact run");
  if (
    run === null ||
    typeof run !== "object" ||
    String(run.id) !== id ||
    run.repository?.full_name !== "Lojhan/typed-sql" ||
    run.path !== ".github/workflows/editor-marketplaces.yml" ||
    run.head_branch !== "main" ||
    !/^[a-f0-9]{40}$/u.test(run.head_sha ?? "") ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed"
  )
    throw new Error("Artifact reuse requires a completed marketplace workflow on main");
  const jobs = await githubJson(`/actions/runs/${id}/jobs?per_page=100`, token, fetchRun, "artifact jobs");
  const artifactJobs = jobs.jobs?.filter((job) => job.name === "artifact");
  // The overall run may have failed after the artifact job succeeded.
  if (artifactJobs?.length !== 1 || artifactJobs[0].status !== "completed" || artifactJobs[0].conclusion !== "success")
    throw new Error("Artifact reuse requires a successful artifact job");
  const comparison = await githubJson(`/compare/${run.head_sha}...${sha}`, token, fetchRun, "artifact ancestry");
  if (comparison.status !== "ahead" && comparison.status !== "identical")
    throw new Error("Artifact source must be an ancestor of the current main commit");
  const evidence = await githubJson(
    `/actions/workflows/ci.yml/runs?event=workflow_dispatch&status=success&head_sha=${run.head_sha}&per_page=100`,
    token,
    fetchRun,
    "artifact CI evidence",
  );
  const candidate = evidence.workflow_runs?.find(
    (entry) => entry.head_sha === run.head_sha && entry.head_branch === "main",
  );
  if (!Number.isSafeInteger(candidate?.id) || candidate.id <= 0)
    throw new Error("Artifact reuse requires successful comprehensive CI for its source commit");
  assertComprehensiveCiRun(candidate, String(candidate?.id), run.head_sha);
  return run.head_sha;
}

export function assertMarketplaceManifest(manifest, xml) {
  if (
    manifest.publisher !== "lojhan" ||
    manifest.name !== "typed-sql" ||
    !/^0\.\d+\.\d+$/u.test(manifest.version) ||
    !/<Property\b[^>]*Id="Microsoft\.VisualStudio\.Code\.PreRelease"[^>]*Value="true"/u.test(xml)
  )
    throw new Error("Only the lojhan.typed-sql experimental prerelease VSIX may be published by this workflow");
}

async function main() {
  if (process.argv[2] === "artifact-source") {
    const commit = await verifyMarketplaceArtifactSource({
      id: process.env.TYPED_SQL_ARTIFACT_RUN_ID,
      sha: process.env.GITHUB_SHA,
      token: process.env.GITHUB_TOKEN,
    });
    console.log(`commit=${commit}`);
    return;
  }
  if (process.argv[2] === "evidence") {
    const id = process.env.TYPED_SQL_EVIDENCE_RUN_ID;
    await verifyComprehensiveCiRun({
      id,
      sha: process.env.GITHUB_SHA,
      token: process.env.GITHUB_TOKEN,
    });
    console.log(`Verified comprehensive CI run ${id} for ${process.env.GITHUB_SHA}`);
    return;
  }
  const root = resolve(import.meta.dirname, "..");
  const vsix = resolve(root, "artifacts/typed-sql-vscode.vsix");
  const metadata = resolve(root, "artifacts/editor-marketplace.json");
  const manifest = JSON.parse((await execFile("unzip", ["-p", vsix, "extension/package.json"])).stdout);
  const xml = (await execFile("unzip", ["-p", vsix, "extension.vsixmanifest"])).stdout;
  assertMarketplaceManifest(manifest, xml);
  const sha256 = createHash("sha256")
    .update(await readFile(vsix))
    .digest("hex");
  if (process.argv[2] === "verify") {
    const expected = JSON.parse(await readFile(metadata, "utf8"));
    const reviewedCommit = process.env.TYPED_SQL_ARTIFACT_COMMIT ?? process.env.GITHUB_SHA;
    if (!/^[a-f0-9]{40}$/u.test(reviewedCommit ?? "")) throw new Error("A reviewed source commit is required");
    if (
      expected.sha256 !== sha256 ||
      expected.commit !== reviewedCommit ||
      expected.prerelease !== true ||
      expected.publisher !== manifest.publisher ||
      expected.name !== manifest.name ||
      expected.version !== manifest.version
    )
      throw new Error("Downloaded editor artifact does not match the reviewed build");
  } else if (process.argv[2] === "record") {
    if (!/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? ""))
      throw new Error("A source commit is required for editor publication");
    await writeFile(
      metadata,
      `${JSON.stringify({ commit: process.env.GITHUB_SHA, publisher: manifest.publisher, name: manifest.name, version: manifest.version, prerelease: true, sha256 }, null, 2)}\n`,
    );
  } else throw new Error("Use evidence, artifact-source, record, or verify");
  console.log(`Verified ${manifest.publisher}.${manifest.name}@${manifest.version} prerelease (${sha256})`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
