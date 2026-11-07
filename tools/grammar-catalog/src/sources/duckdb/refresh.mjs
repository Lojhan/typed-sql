import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hash } from "../../model/canonical.mjs";
import { checkLockedFacts, parseSourceLock, verifySourceFiles } from "../../provenance/source-lock.mjs";
import { extractorId, extractorRevision, parseSignatureOutput, validateSourceFacts } from "./facts.mjs";

const execFile = promisify(execFileCallback);
const repository = "https://github.com/duckdb/duckdb";
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function download(url) {
  const response = await fetch(url, { headers: { "User-Agent": "typed-sql-catalog" } });
  if (!response.ok) throw new Error(`Vendor source HTTP ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Explicit acquisition only. Ordinary catalog generation reads retained JSON offline. */
export async function refreshDuckDBSources({ root, compiler = "c++", version }) {
  const corpus = JSON.parse(await readFile(join(root, "grammar/catalog/upstream.json"), "utf8"));
  const versions = version
    ? [version]
    : [
        ...new Set(
          Object.values(corpus.targets)
            .filter((target) => target.dialect === "duckdb")
            .map((target) => target.target.version),
        ),
      ].sort();
  if (!versions.length) throw new TypeError("No DuckDB source targets");
  const results = [];
  for (const selected of versions) results.push(await refreshVersion({ root, compiler, version: selected }));
  return { versions: results.length, results };
}

async function refreshVersion({ root, compiler, version }) {
  if (!/^[12]\.\d+\.\d+$/u.test(version)) throw new TypeError("Unqualified DuckDB source API");
  const signatureApi = Number(version.split(".")[0]);
  const profile = `${process.platform}-${process.arch}`;
  const platform = {
    "darwin-arm64": "osx-arm64",
    "darwin-x64": "osx-amd64",
    "linux-x64": "linux-amd64",
    "linux-arm64": "linux-arm64",
  }[profile];
  if (!platform) throw new TypeError(`Unqualified DuckDB extraction platform: ${profile}`);
  const lockPath = join(root, "grammar/duckdb/sources.lock.json");
  let previous;
  try {
    previous = parseSourceLock(JSON.parse(await readFile(lockPath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const existing = previous?.sources.find((entry) => entry.version === version);
  const previousFacts = previous
    ? JSON.parse(await readFile(join(root, "grammar/duckdb/facts/catalog.json"), "utf8"))
    : { formatVersion: 1, grammar: "duckdb", versions: {} };
  if (previous) checkLockedFacts(previous, previousFacts, validateSourceFacts);
  const reference = `v${version}`;
  const ref = existing
    ? undefined
    : JSON.parse(
        (await download(`https://api.github.com/repos/duckdb/duckdb/git/ref/tags/${reference}`)).toString("utf8"),
      );
  const revision = existing?.revision ?? (ref.object?.type === "commit" ? ref.object.sha : undefined);
  if (!/^[a-f0-9]{40}$/u.test(revision ?? "")) throw new TypeError("Unsupported DuckDB source reference");
  const archives = {
    1: `libduckdb-${process.platform === "darwin" ? "osx-universal" : platform}.zip`,
    2: `duckdb-shared-libs-${platform}.tar.gz`,
  };
  const archiveName = archives[signatureApi];
  const paths = ["source.tar.gz", "LICENSE", archiveName];
  const directory = join(root, "artifacts/grammar-catalog/acquisitions/duckdb", revision);
  await mkdir(directory, { recursive: true });
  const files = {};
  for (const path of paths) {
    let bytes;
    try {
      bytes = await readFile(join(directory, path));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      bytes = await download(
        path === "source.tar.gz"
          ? `https://codeload.github.com/duckdb/duckdb/tar.gz/${revision}`
          : path === "LICENSE"
            ? `https://raw.githubusercontent.com/duckdb/duckdb/${revision}/LICENSE`
            : `${repository}/releases/download/${reference}/${archiveName}`,
      );
      await writeFile(join(directory, path), bytes);
    }
    files[path] = { digest: digest(bytes), bytes: bytes.length };
  }
  if (existing && hash(existing.files) !== hash(files))
    throw new TypeError("Locked DuckDB vendor bytes/platform changed");
  await verifySourceFiles(directory, files);
  const workspace = await mkdtemp(join(tmpdir(), "typed-sql-duckdb-source-"));
  let facts;
  try {
    const extractor = fileURLToPath(new URL("extract-archive.py", import.meta.url));
    await execFile("python3", [extractor, join(directory, "source.tar.gz"), workspace, `duckdb-${revision}`]);
    await execFile("python3", [extractor, join(directory, archiveName), workspace, "--flat"]);
    const binary = join(workspace, "typed-sql-signatures");
    await execFile(
      compiler,
      [
        "-std=c++17",
        "-I",
        join(workspace, `duckdb-${revision}/src/include`),
        fileURLToPath(new URL(`extract-v${signatureApi}.cpp`, import.meta.url)),
        "-L",
        workspace,
        "-lduckdb",
        `-Wl,-rpath,${workspace}`,
        "-o",
        binary,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const { stdout } = await execFile(binary, [], { maxBuffer: 32 * 1024 * 1024 });
    facts = parseSignatureOutput(stdout, { version, revision, profile, signatureApi });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  const lock = parseSourceLock({
    formatVersion: 1,
    grammar: "duckdb",
    extractor: { id: extractorId, revision: await extractorRevision() },
    sources: [
      ...(previous?.sources.filter((entry) => entry.version !== version) ?? []),
      {
        version,
        reference,
        repository,
        revision,
        upstreamRevision: revision,
        files,
        license: { identifier: "MIT", path: "LICENSE" },
        defines: facts.defines,
        factsDigest: hash(facts),
      },
    ].sort((a, b) => a.version.localeCompare(b.version)),
  });
  await mkdir(join(root, "grammar/duckdb/facts"), { recursive: true });
  await writeFile(
    join(root, "grammar/duckdb/facts/catalog.json"),
    `${JSON.stringify({ ...previousFacts, versions: { ...previousFacts.versions, [version]: facts } }, null, 2)}\n`,
  );
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return { version, profile, registrations: facts.registrations.length };
}
