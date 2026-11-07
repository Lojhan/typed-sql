import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { hash } from "../../model/canonical.mjs";
import { parseSourceLock, verifySourceFiles } from "../../provenance/source-lock.mjs";
import {
  addCatalogFacts,
  checkSourceTexts,
  extractorId,
  extractorRevision,
  parseKeywords,
  validateSourceFacts,
} from "./facts.mjs";

const execFile = promisify(callback);
const repository = "https://github.com/postgres/postgres";
const bytesDigest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function download(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    headers: { "User-Agent": "typed-sql-catalog" },
  });
  if (!response.ok) throw new Error(`Vendor source HTTP ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function refreshPostgresSources({ root, perl = "perl", python = "python3" }) {
  const corpus = JSON.parse(await readFile(join(root, "grammar/catalog/upstream.json"), "utf8"));
  const versions = [
    ...new Set(
      Object.values(corpus.targets)
        .filter((target) => target.dialect === "postgres")
        .map((target) => {
          const match = /^(\d+(?:\.\d+|beta\d+))(?:\s|$)/u.exec(target.target.version);
          if (!match) throw new TypeError(`Unsupported PostgreSQL source version: ${target.target.version}`);
          return match[1];
        }),
    ),
  ].sort();
  if (!versions.length) throw new TypeError("No PostgreSQL native source targets");
  const lockPath = join(root, "grammar/postgres/sources.lock.json");
  let previous;
  try {
    previous = parseSourceLock(JSON.parse(await readFile(lockPath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const facts = { formatVersion: 1, grammar: "postgres", schemas: {}, rows: {}, texts: {}, versions: {} };
  const sources = [];
  for (const version of versions) {
    const reference = `REL_${version.replaceAll(".", "_").replace("beta", "_BETA")}`;
    const existing = previous?.sources.find((source) => source.version === version);
    const ref = existing
      ? undefined
      : JSON.parse(
          (await download(`https://api.github.com/repos/postgres/postgres/git/ref/tags/${reference}`)).toString("utf8"),
        );
    const revision = existing?.revision ?? (ref.object?.type === "commit" ? ref.object.sha : undefined);
    if (!/^[a-f0-9]{40}$/u.test(revision ?? "")) throw new TypeError("Unsupported PostgreSQL source revision");
    const directory = resolve(root, "artifacts/grammar-catalog/acquisitions/postgres", revision);
    await mkdir(directory, { recursive: true });
    const archive = join(directory, "source.tar.gz");
    let bytes;
    try {
      bytes = await readFile(archive);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      bytes = await download(`https://codeload.github.com/postgres/postgres/tar.gz/${revision}`);
      await writeFile(archive, bytes);
    }
    const archivePin = { digest: bytesDigest(bytes), bytes: bytes.length };
    if (existing && hash(existing.files["source.tar.gz"]) !== hash(archivePin))
      throw new TypeError("Locked PostgreSQL archive changed");
    const prefix = `postgres-${revision}`;
    const { stdout: selected } = await execFile(python, [
      new URL("extract-archive.py", import.meta.url).pathname,
      archive,
      directory,
      prefix,
    ]);
    const paths = JSON.parse(selected);
    const sourceRoot = join(directory, prefix);
    const files = { "source.tar.gz": archivePin };
    for (const path of paths) {
      const content = await readFile(join(sourceRoot, path));
      files[`${prefix}/${path}`] = { digest: bytesDigest(content), bytes: content.length };
    }
    if (existing && Object.entries(existing.files).some(([path, pin]) => hash(pin) !== hash(files[path])))
      throw new TypeError("Locked PostgreSQL source bytes changed");
    await verifySourceFiles(directory, files);
    const configure = await readFile(join(sourceRoot, "configure.ac"), "utf8");
    if (/AC_INIT\(\[PostgreSQL\],\s*\[([^\]]+)\]/u.exec(configure)?.[1] !== version)
      throw new TypeError("PostgreSQL source/target version differs");
    const { stdout } = await execFile(perl, [new URL("extract.pl", import.meta.url).pathname, sourceRoot], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const catalogs = JSON.parse(stdout);
    const keywords = parseKeywords(await readFile(join(sourceRoot, "src/include/parser/kwlist.h"), "utf8"));
    const uninterpretedInputs = paths.filter(
      (path) => path.endsWith(".sql") || path.endsWith(".txt") || path.endsWith("gram.y"),
    );
    const textInputs = Object.fromEntries(
      await Promise.all(
        paths
          .filter((path) => path.endsWith(".sql") || path.endsWith("gram.y") || path.endsWith("bootstrap.c"))
          .map(async (path) => [path, await readFile(join(sourceRoot, path), "utf8")]),
      ),
    );
    const licenseNotice = await readFile(join(sourceRoot, "COPYRIGHT"), "utf8");
    const value = addCatalogFacts(facts, {
      version,
      revision,
      catalogs,
      keywords,
      uninterpretedInputs,
      textInputs,
      licenseNotice,
    });
    sources.push({
      version,
      reference,
      repository,
      revision,
      upstreamRevision: revision,
      files,
      license: { identifier: "PostgreSQL", path: `${prefix}/COPYRIGHT` },
      defines: value.defines,
      factsDigest: hash(value),
    });
    console.log(
      `postgres ${version}: ${Object.keys(catalogs).length} catalogs; ${catalogs.pg_proc.rows.length} procedures; ${keywords.length} keywords`,
    );
  }
  validateSourceFacts(facts);
  const lock = parseSourceLock({
    formatVersion: 1,
    grammar: "postgres",
    extractor: { id: extractorId, revision: await extractorRevision() },
    sources,
  });
  checkSourceTexts(lock, facts);
  await mkdir(join(root, "grammar/postgres/facts"), { recursive: true });
  await writeFile(join(root, "grammar/postgres/facts/catalog.json"), `${JSON.stringify(facts)}\n`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return {
    versions: versions.length,
    sharedRows: Object.keys(facts.rows).length,
    sharedSchemas: Object.keys(facts.schemas).length,
  };
}
