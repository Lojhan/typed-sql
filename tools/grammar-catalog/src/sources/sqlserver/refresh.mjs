import { execFile as callback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hash } from "../../model/canonical.mjs";
import { parseSourceLock, verifySourceFiles } from "../../provenance/source-lock.mjs";
import { bytesDigest, extractorId, extractorRevision, validateSourceFacts } from "./facts.mjs";
import { parseGrammar } from "./grammar.mjs";

const execFile = promisify(callback),
  repository = "https://github.com/microsoft/SqlScriptDOM",
  commonPath = "SqlScriptDom/Parser/TSql/TSqlTokenTypes.g";
async function download(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    headers: { "User-Agent": "typed-sql-catalog" },
  });
  if (!response.ok) throw new Error(`ScriptDOM source HTTP ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function refreshSQLServerSources({ root, python = "python3" }) {
  const corpus = JSON.parse(await readFile(join(root, "grammar/catalog/upstream.json"), "utf8")),
    profiles = new Map();
  for (const [id, target] of Object.entries(corpus.targets)) {
    if (target.dialect !== "sqlserver") continue;
    const compatibilityLevel = target.target.settings?.compatibilityLevel;
    if (!Number.isInteger(compatibilityLevel) || !/^[1-9][0-9]{2}$/u.test(String(compatibilityLevel)))
      throw new TypeError("Missing SQL Server source compatibility profile");
    const version = String(compatibilityLevel);
    profiles.set(version, [
      ...(profiles.get(version) ?? []),
      { id, version: target.target.version, compatibilityLevel },
    ]);
  }
  if (!profiles.size) throw new TypeError("No SQL Server source profiles");
  const lockPath = join(root, "grammar/sqlserver/sources.lock.json");
  let previous;
  try {
    previous = parseSourceLock(JSON.parse(await readFile(lockPath, "utf8")));
    if (previous.grammar !== "sqlserver") throw new TypeError("SQL Server source lock owner differs");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const facts = { formatVersion: 1, grammar: "sqlserver", versions: {} },
    sources = [];
  let currentRevision;
  for (const [version, targets] of [...profiles].sort(([a], [b]) => a.localeCompare(b))) {
    const existing = previous?.sources.find((source) => source.version === version);
    if (!existing && !currentRevision) {
      const ref = JSON.parse(
        (await download("https://api.github.com/repos/microsoft/SqlScriptDOM/git/ref/heads/main")).toString("utf8"),
      );
      currentRevision = ref.object?.type === "commit" ? ref.object.sha : undefined;
    }
    const revision = existing?.revision ?? currentRevision;
    if (!/^[a-f0-9]{40}$/u.test(revision ?? "")) throw new TypeError("Unsupported ScriptDOM source revision");
    const directory = resolve(root, "artifacts/grammar-catalog/acquisitions/sqlserver", revision);
    await mkdir(directory, { recursive: true });
    const archive = join(directory, "source.tar.gz");
    let bytes;
    try {
      bytes = await readFile(archive);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      bytes = await download(`https://codeload.github.com/microsoft/SqlScriptDOM/tar.gz/${revision}`);
      await writeFile(archive, bytes);
    }
    const files = { "source.tar.gz": { digest: bytesDigest(bytes), bytes: bytes.length } };
    if (existing && hash(existing.files["source.tar.gz"]) !== hash(files["source.tar.gz"]))
      throw new TypeError("Locked ScriptDOM archive changed");
    const grammarPath = `SqlScriptDom/Parser/TSql/TSql${version}.g`,
      paths = ["LICENSE", commonPath, grammarPath],
      prefix = `SqlScriptDOM-${revision}`;
    await execFile(python, [
      fileURLToPath(new URL("extract-archive.py", import.meta.url)),
      archive,
      directory,
      prefix,
      JSON.stringify(paths),
    ]);
    for (const path of paths) {
      const content = await readFile(join(directory, prefix, path));
      files[`${prefix}/${path}`] = { digest: bytesDigest(content), bytes: content.length };
    }
    if (existing && Object.entries(existing.files).some(([path, pin]) => hash(pin) !== hash(files[path])))
      throw new TypeError("Locked ScriptDOM member bytes changed");
    await verifySourceFiles(directory, files);
    async function unit(path) {
      const bytes = await readFile(join(directory, prefix, path)),
        text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) throw new TypeError("Non-UTF8 ScriptDOM source input");
      return { path, offsetEncoding: "utf16", text, digest: bytesDigest(bytes), ...parseGrammar(text) };
    }
    const value = validateSourceFacts({
      version,
      revision,
      defines: [],
      scope: "ScriptDOM parser source; engine binding and semantic qualification are separate",
      licenseNotice: await readFile(join(directory, prefix, "LICENSE"), "utf8"),
      common: await unit(commonPath),
      grammar: await unit(grammarPath),
      targets: targets.sort((a, b) => a.id.localeCompare(b.id)),
    });
    facts.versions[version] = value;
    sources.push({
      version,
      reference: existing?.reference ?? "main",
      repository,
      revision,
      upstreamRevision: revision,
      files,
      license: { identifier: "MIT", path: `${prefix}/LICENSE` },
      defines: [],
      factsDigest: hash(value),
    });
    console.log(
      `scriptdom ${version}: ${value.grammar.productions.length} productions; ${value.targets.length} native contexts`,
    );
  }
  const lock = parseSourceLock({
    formatVersion: 1,
    grammar: "sqlserver",
    extractor: { id: extractorId, revision: await extractorRevision() },
    sources,
  });
  await mkdir(join(root, "grammar/sqlserver/facts"), { recursive: true });
  await writeFile(join(root, "grammar/sqlserver/facts/catalog.json"), `${JSON.stringify(facts)}\n`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return { profiles: sources.length, contexts: [...profiles.values()].reduce((sum, values) => sum + values.length, 0) };
}
