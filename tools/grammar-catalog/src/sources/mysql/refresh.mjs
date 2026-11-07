import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { hash } from "../../model/canonical.mjs";
import { parseSourceLock, verifySourceFiles } from "../../provenance/source-lock.mjs";
import { extractorId, extractorRevision, validateSourceFacts } from "./facts.mjs";
import { functions, keywords } from "./parse.mjs";

const execFile = promisify(callback);
const repository = "https://github.com/mysql/mysql-server";
const bytesDigest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function download(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    headers: { "User-Agent": "typed-sql-catalog" },
  });
  if (!response.ok) throw new Error(`Vendor source HTTP ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function refreshMySQLSources({ root, python = "python3" }) {
  const corpus = JSON.parse(await readFile(join(root, "grammar/catalog/upstream.json"), "utf8"));
  const versions = [
    ...new Set(
      Object.values(corpus.targets)
        .filter((target) => target.dialect === "mysql")
        .map((target) => {
          const match = /^(\d+\.\d+\.\d+)(?:\s|$)/u.exec(target.target.version);
          if (!match) throw new TypeError(`Unsupported MySQL source version: ${target.target.version}`);
          return match[1];
        }),
    ),
  ].sort();
  if (!versions.length) throw new TypeError("No MySQL native source targets");
  const lockPath = join(root, "grammar/mysql/sources.lock.json");
  let previous;
  try {
    previous = parseSourceLock(JSON.parse(await readFile(lockPath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const facts = { formatVersion: 1, grammar: "mysql", versions: {} };
  const sources = [];
  for (const version of versions) {
    const reference = `mysql-${version}`;
    const existing = previous?.sources.find((source) => source.version === version);
    const ref = existing
      ? undefined
      : JSON.parse(
          (await download(`https://api.github.com/repos/mysql/mysql-server/git/ref/tags/${reference}`)).toString(
            "utf8",
          ),
        );
    const revision = existing?.revision ?? (ref.object?.type === "commit" ? ref.object.sha : undefined);
    if (!/^[a-f0-9]{40}$/u.test(revision ?? "")) throw new TypeError("Unsupported MySQL source revision");
    const directory = resolve(root, "artifacts/grammar-catalog/acquisitions/mysql", revision);
    await mkdir(directory, { recursive: true });
    const archive = join(directory, "source.tar.gz");
    let bytes;
    try {
      bytes = await readFile(archive);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      bytes = await download(`https://codeload.github.com/mysql/mysql-server/tar.gz/${revision}`);
      await writeFile(archive, bytes);
    }
    const archivePin = { digest: bytesDigest(bytes), bytes: bytes.length };
    if (existing && hash(existing.files["source.tar.gz"]) !== hash(archivePin))
      throw new TypeError("Locked MySQL archive changed");
    const prefix = `mysql-server-${revision}`;
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
      throw new TypeError("Locked MySQL source bytes changed");
    await verifySourceFiles(directory, files);
    const metadata = await readFile(join(sourceRoot, "MYSQL_VERSION"), "utf8");
    const parts = ["MAJOR", "MINOR", "PATCH"].map(
      (key) => new RegExp(`^MYSQL_VERSION_${key}=(\\d+)$`, "mu").exec(metadata)?.[1],
    );
    if (parts.join(".") !== version) throw new TypeError("MySQL source/target version differs");
    const value = validateSourceFacts({
      version,
      revision,
      defines: [],
      licenseNotice: await readFile(join(sourceRoot, "LICENSE"), "utf8"),
      ...keywords(
        await readFile(join(sourceRoot, "sql/lex.h"), "utf8"),
        await readFile(join(sourceRoot, "sql/sql_yacc.yy"), "utf8"),
      ),
      functions: functions(await readFile(join(sourceRoot, "sql/item_create.cc"), "utf8")),
    });
    facts.versions[version] = value;
    sources.push({
      version,
      reference,
      repository,
      revision,
      upstreamRevision: revision,
      files,
      license: { identifier: "GPL-2.0-only", path: `${prefix}/LICENSE` },
      defines: value.defines,
      factsDigest: hash(value),
    });
    console.log(
      `mysql ${version}: ${value.functions.length} registrations; ${value.keywords.length} keywords; ${value.lexicalFunctions.length} lexical functions`,
    );
  }
  const lock = parseSourceLock({
    formatVersion: 1,
    grammar: "mysql",
    extractor: { id: extractorId, revision: await extractorRevision() },
    sources,
  });
  await mkdir(join(root, "grammar/mysql/facts"), { recursive: true });
  await writeFile(join(root, "grammar/mysql/facts/catalog.json"), `${JSON.stringify(facts)}\n`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return {
    versions: versions.length,
    registrations: Object.values(facts.versions).reduce((sum, value) => sum + value.functions.length, 0),
  };
}
