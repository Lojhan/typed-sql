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
  functionCoverage,
  validateSourceFacts,
} from "../../tools/grammar-catalog/src/sources/sqlite/facts.mjs";
import {
  parseFunctionOutput,
  validateFunctionProfile,
} from "../../tools/grammar-catalog/src/sources/sqlite/functions.mjs";
import { keywordCoverage, parseKeywordOutput } from "../../tools/grammar-catalog/src/sources/sqlite/keywords.mjs";

await describe("locked vendor source facts", async () => {
  await it("validates every retained SQLite source version and accounts for every keyword", async () => {
    const lock = JSON.parse(await readFile(new URL("../../grammar/sqlite/sources.lock.json", import.meta.url), "utf8"));
    const facts = JSON.parse(
      await readFile(new URL("../../grammar/sqlite/facts/catalog.json", import.meta.url), "utf8"),
    );
    checkLockedFacts(lock, facts, validateSourceFacts);
    strict.equal(lock.extractor.revision, await extractorRevision());
    const attributes = await readFile(new URL("../../.gitattributes", import.meta.url), "utf8");
    strict.ok(attributes.includes("tools/grammar-catalog/src/sources/** text eol=lf"));
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
    strict.throws(() => checkLockedFacts(lock, changed, validateSourceFacts), /disagree/u);
    const missing = structuredClone(lock);
    delete missing.sources[0].files[missing.sources[0].license.path];
    strict.throws(() => parseSourceLock(missing), /license/u);
  });
  await it("retains conditional registrations and version-specific binder arities", async () => {
    const facts = JSON.parse(
      await readFile(new URL("../../grammar/sqlite/facts/catalog.json", import.meta.url), "utf8"),
    );
    const policy = JSON.parse(
      await readFile(new URL("../../grammar/sqlite/catalog/policy.json", import.meta.url), "utf8"),
    );
    const coverage = functionCoverage(facts, policy);
    for (const [version, value] of Object.entries(facts.versions)) {
      const profiles = (value as { functionProfiles: unknown[] }).functionProfiles.map(validateFunctionProfile);
      strict.equal(profiles.length, 2);
      const baseline = profiles.find((profile) => profile.id === "default")!;
      const extended = profiles.find((profile) => profile.id === "extended")!;
      strict.equal(
        baseline.registrations.some((row) => row.name === "sin"),
        false,
      );
      strict.equal(
        extended.registrations.some((row) => row.name === "sin"),
        true,
      );
      strict.equal(
        extended.visible.some((row) => row.name === "fts5" && !row.builtin),
        true,
      );
      const iif = baseline.registrations.find((row) => row.name === "iif")!;
      strict.equal(iif.binderMinimumArguments, version === "3.39.0" || version === "3.47.2" ? 3 : 2);
      strict.equal(baseline.registrations.find((row) => row.name === "sum")!.windowCapable, true);
      strict.equal(baseline.registrations.find((row) => row.name === "rank")!.kind, "window");
      strict.equal(coverage[version]!.default!.registrations.length, baseline.registrations.length);
      strict.equal(
        coverage[version]!.extended!.connectionOnly.length,
        extended.visible.filter((row) => !row.builtin).length,
      );
      const changed = structuredClone(baseline);
      changed.registrations[0]!.binderMinimumArguments = -1;
      strict.throws(() => validateFunctionProfile(changed), /Invalid/u);
    }
  });
  await it("rejects missing, duplicate, truncated or unfamiliar function frames", () => {
    const text = [
      "version\t3.54.1",
      "sourceId\tpinned-source",
      "maximumFunctionArguments\t1000",
      "option\tMAX_FUNCTION_ARG=1000",
      "registration\tiif\t-4\t1\t1\t2\tscalar\t0\t0\tend",
      "visible\tiif\t1\ts\tutf8\t-4\t1",
    ].join("\n");
    const options = { id: "default", defines: [] };
    const value = parseFunctionOutput(text, options);
    strict.equal(value.registrations[0]!.binderMinimumArguments, 2);
    strict.equal(value.registrations[0]!.arity, -4);
    for (const bad of [
      "",
      text.replace("version\t3.54.1\n", ""),
      `${text}\nversion\t3.54.1`,
      text.replace("\tend", ""),
      `${text}\nnew-kind\tvalue`,
      text.replace("\t-4\t1\t1\t2", "\t-2\t1\t1\t2"),
      `${text}\nvisible\tiif\t1\ts\tutf8\t-4\t1`,
    ])
      strict.throws(() => parseFunctionOutput(bad, options), /SQLite/u);
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
