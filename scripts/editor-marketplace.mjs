import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(callback);
export function assertMarketplaceEvidence(run, sha) {
  if (
    run.repository?.full_name !== "Lojhan/typed-sql" ||
    run.path !== ".github/workflows/ci.yml" ||
    run.head_branch !== "main" ||
    run.head_sha !== sha ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw new Error("Editor publication requires successful comprehensive CI for the exact main commit");
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
  if (process.argv[2] === "evidence") {
    const id = process.env.TYPED_SQL_EVIDENCE_RUN_ID;
    if (!/^\d+$/u.test(id ?? "") || !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? ""))
      throw new Error("Invalid CI evidence run or source commit");
    const response = await fetch(`https://api.github.com/repos/Lojhan/typed-sql/actions/runs/${id}`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`Could not read CI evidence (${response.status})`);
    assertMarketplaceEvidence(await response.json(), process.env.GITHUB_SHA);
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
    if (
      expected.sha256 !== sha256 ||
      expected.commit !== process.env.GITHUB_SHA ||
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
  } else throw new Error("Use evidence, record, or verify");
  console.log(`Verified ${manifest.publisher}.${manifest.name}@${manifest.version} prerelease (${sha256})`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
