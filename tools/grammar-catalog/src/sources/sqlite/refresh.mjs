import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "../../model/canonical.mjs";
import { parseSourceLock, verifySourceFiles } from "../../provenance/source-lock.mjs";
import { extractorId, extractorRevision, validateSourceFacts } from "./facts.mjs";
import { extractFunctions } from "./functions.mjs";
import { extractKeywords } from "./keywords.mjs";

const repository = "https://github.com/sqlite/sqlite";
const paths = ["VERSION", "manifest.uuid", "LICENSE.md", "tool/mkkeywordhash.c", "src/func.c", "source.tar.gz"];
const bytesDigest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function download(url) {
  const response = await fetch(url, { headers: { "User-Agent": "typed-sql-catalog" } });
  if (!response.ok) throw new Error(`Vendor source HTTP ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
export async function refreshSQLiteSources({ root, compiler = "cc" }) {
  const corpus = JSON.parse(await readFile(join(root, "grammar/catalog/upstream.json"), "utf8"));
  const ledger = JSON.parse(await readFile(join(root, "grammar/features/ledger.json"), "utf8"));
  const versions = [
    ...new Set([
      ...Object.values(corpus.targets)
        .filter((target) => target.dialect === "sqlite")
        .map((target) => target.target.version),
      ...[...ledger.dialects.sqlite.stable, ...ledger.dialects.sqlite.canary].flatMap((range) => [
        range.minimum,
        range.maximum,
      ]),
    ]),
  ].sort();
  const lockPath = join(root, "grammar/sqlite/sources.lock.json");
  let previous;
  try {
    previous = parseSourceLock(JSON.parse(await readFile(lockPath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const entries = [],
    facts = { formatVersion: 1, grammar: "sqlite", versions: {} };
  for (const version of versions) {
    if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new TypeError(`Unsupported SQLite source version: ${version}`);
    const existing = previous?.sources.find((source) => source.version === version);
    const reference = `version-${version}`;
    const ref = existing
      ? undefined
      : JSON.parse(
          (await download(`https://api.github.com/repos/sqlite/sqlite/git/ref/tags/${reference}`)).toString("utf8"),
        );
    const revision = existing?.revision ?? (ref.object?.type === "commit" ? ref.object.sha : undefined);
    if (!/^[a-f0-9]{40}$/u.test(revision ?? "")) throw new TypeError("Unsupported SQLite source reference");
    const directory = join(root, "artifacts/grammar-catalog/acquisitions/sqlite", revision),
      files = {};
    for (const path of paths) {
      const file = join(directory, path);
      let bytes;
      try {
        bytes = await readFile(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        bytes = await download(
          path === "source.tar.gz"
            ? `https://codeload.github.com/sqlite/sqlite/tar.gz/${revision}`
            : `https://raw.githubusercontent.com/sqlite/sqlite/${revision}/${path}`,
        );
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, bytes);
      }
      files[path] = { digest: bytesDigest(bytes), bytes: bytes.length };
    }
    if (existing && Object.entries(existing.files).some(([path, pin]) => hash(pin) !== hash(files[path])))
      throw new TypeError(`Locked SQLite source bytes changed: ${version}`);
    await verifySourceFiles(directory, files);
    const value = await extractKeywords({ directory, version, revision, compiler });
    const upstreamRevision = (await readFile(join(directory, "manifest.uuid"), "utf8")).trim();
    value.functionProfiles = await extractFunctions({ directory, version, revision, upstreamRevision, compiler });
    validateSourceFacts(value);
    facts.versions[version] = value;
    entries.push({
      version,
      reference,
      revision,
      repository,
      upstreamRevision,
      files,
      license: { identifier: "LicenseRef-SQLite-Public-Domain", path: "LICENSE.md" },
      defines: value.defines,
      factsDigest: hash(value),
    });
  }
  const lock = parseSourceLock({
    formatVersion: 1,
    grammar: "sqlite",
    extractor: { id: extractorId, revision: await extractorRevision() },
    sources: entries,
  });
  await mkdir(join(root, "grammar/sqlite/facts"), { recursive: true });
  await writeFile(join(root, "grammar/sqlite/facts/catalog.json"), `${JSON.stringify(facts, null, 2)}\n`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return {
    versions: versions.length,
    keywords: Object.values(facts.versions).reduce((sum, fact) => sum + fact.keywords.length, 0),
  };
}
