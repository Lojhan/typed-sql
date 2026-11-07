import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  checkLockedFacts,
  parseSourceLock,
  verifySourceFiles,
} from "../../tools/grammar-catalog/src/provenance/source-lock.mjs";
import {
  extractorRevision,
  keywordCoverage,
  parseKeywordOutput,
  validateKeywordFacts,
} from "../../tools/grammar-catalog/src/sources/sqlite/keywords.mjs";

await describe("locked vendor source facts", async () => {
  await it("validates every retained SQLite source version and accounts for every keyword", async () => {
    const lock = JSON.parse(await readFile(new URL("../../grammar/sqlite/sources.lock.json", import.meta.url), "utf8"));
    const facts = JSON.parse(
      await readFile(new URL("../../grammar/sqlite/facts/keywords.json", import.meta.url), "utf8"),
    );
    checkLockedFacts(lock, facts, validateKeywordFacts);
    strict.equal(lock.extractor.revision, await extractorRevision());
    const corpus = JSON.parse(await readFile(new URL("../../grammar/catalog/upstream.json", import.meta.url), "utf8"));
    const versions = [
      ...new Set(
        Object.values(corpus.targets)
          .filter(
            (target: unknown) =>
              typeof target === "object" && target !== null && "dialect" in target && target.dialect === "sqlite",
          )
          .map((target: unknown) => {
            if (!target || typeof target !== "object" || !("target" in target)) throw new Error("missing target");
            return (target.target as { version: string }).version;
          }),
      ),
    ].sort();
    strict.deepEqual(
      lock.sources.map((source: { version: string }) => source.version),
      versions,
    );
    const coverage = keywordCoverage(facts, ["SELECT", "unsupported_token"]);
    for (const [version, value] of Object.entries(facts.versions)) {
      const keywords = (value as { keywords: { enabled: boolean }[] }).keywords;
      strict.equal(
        coverage[version]!.sourceOnly.length +
          coverage[version]!.recognizedByParser.length +
          coverage[version]!.disabled.length,
        keywords.length,
      );
    }
    const changed = structuredClone(facts);
    changed.versions[versions[0]!].keywords[0].token = "TK_FORGED";
    strict.throws(() => checkLockedFacts(lock, changed, validateKeywordFacts), /disagree/u);
    const missing = structuredClone(lock);
    delete missing.sources[0].files[missing.sources[0].license.path];
    strict.throws(() => parseSourceLock(missing), /license/u);
  });
  await it("rejects unfamiliar extraction output instead of dropping rows", () => {
    strict.deepEqual(parseKeywordOutput("SELECT\tTK_SELECT\t2\n"), [
      { name: "SELECT", token: "TK_SELECT", mask: 2, enabled: true },
    ]);
    for (const text of [
      "",
      "SELECT\tTK_SELECT\t2\nSELECT\tTK_SELECT\t2",
      "SELECT\tunknown\t2",
      "SELECT\tTK_SELECT\tNaN",
    ])
      strict.throws(() => parseKeywordOutput(text), /keyword/u);
  });
  await it("rejects changed acquisition bytes before extraction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-vendor-bytes-"));
    try {
      await writeFile(join(directory, "VERSION"), "changed");
      await strict.rejects(
        verifySourceFiles(directory, { VERSION: { digest: `sha256:${"0".repeat(64)}`, bytes: 7 } }),
        /bytes disagree/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
