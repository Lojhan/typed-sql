import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  addCapture,
  emptyCorpus,
  readCorpus,
  verifyCaptureInput,
  writeCorpus,
} from "../../scripts/catalog-generation/corpus.mjs";
import { CATEGORIES, inventory, unavailable } from "../../scripts/language-audit/inventory.mjs";
import { attachNativeProvenance } from "../../scripts/language-audit/provenance.mjs";
import { importLegacyCorpus } from "../../tools/grammar-catalog/src/import/legacy.mjs";
import { createCatalog } from "../../tools/grammar-catalog/src/model/build.mjs";
import { hash } from "../../tools/grammar-catalog/src/model/canonical.mjs";
import {
  createCaptureProvenance,
  validateCaptureProvenance,
} from "../../tools/grammar-catalog/src/provenance/capture.mjs";
import { createMapperRegistry, numericVersionBand } from "../../tools/grammar-catalog/src/registry.mjs";

const registry = createMapperRegistry([
  {
    id: "external",
    versionBand: numericVersionBand(1),
    normalizeRow: (_category: string, row: unknown) => row,
    routineFacts: () => ({}),
  },
]);
type Provenance = ReturnType<typeof validateCaptureProvenance>;
type IsAny<T> = 0 extends 1 & T ? true : false;
const digestIsAny: IsAny<Provenance["extractor"]["files"][string]> = false;
void digestIsAny;
// @ts-expect-error Extractor revisions are statically typed digest strings.
const invalidRevision: Provenance["extractor"]["revision"] = 42;
void invalidRevision;
const categories = () =>
  Object.fromEntries(
    CATEGORIES.map((name) => [
      name,
      name === "types" ? inventory([{ name: "vertex" }], "independent native type query") : unavailable("not exposed"),
    ]),
  );
const extractor = {
  id: "external/capture",
  files: { "extractor.mjs": hash("source bytes") },
  dependencyLock: hash("dependency lock bytes"),
  runtime: { name: "node" as const, version: process.version },
};
const options = {
  requiredCategories: [...CATEGORIES],
  inputDigest: hash("input"),
  normalizerDigest: hash("normalizer"),
  sourceLocation: "urn:test:capture",
};
await describe("bound native extractor provenance", async () => {
  await it("binds every category, query, profile and extractor field", () => {
    const capture = { grammar: "external", target: { version: "1.2.3" }, categories: categories() };
    const provenance = createCaptureProvenance(capture, extractor);
    strict.deepEqual(validateCaptureProvenance(provenance, capture), provenance);
    strict.throws(
      () => validateCaptureProvenance(provenance, { ...capture, target: { version: "1.2.4" } }),
      /capture digest/u,
    );
    strict.throws(
      () =>
        validateCaptureProvenance(provenance, {
          ...capture,
          categories: { ...capture.categories, types: inventory([{ name: "other" }], "independent native type query") },
        }),
      /capture digest/u,
    );
    const changed = structuredClone(provenance);
    changed.extractor.runtime.version = "different";
    strict.throws(() => validateCaptureProvenance(changed, capture), /manifest digest/u);
    strict.throws(
      () => createCaptureProvenance(capture, { ...extractor, files: { "../escape": hash("bad") } }),
      /Noncanonical/u,
    );
    strict.throws(() => createCaptureProvenance(capture, { ...extractor, files: {} }), /Invalid/u);
  });
  await it("retains provenance through corpus persistence and only qualifies the supplied extractor fact", async () => {
    const input = { dialect: "external", target: { version: "1.2.3" }, categories: categories() };
    const capture = { grammar: input.dialect, target: input.target, categories: input.categories };
    const provenance = createCaptureProvenance(capture, extractor);
    const corpus = emptyCorpus();
    await addCapture(corpus, { ...input, provenance }, registry);
    strict.equal((await verifyCaptureInput({ ...input, provenance }, corpus, registry)).status, "match");
    strict.equal((await verifyCaptureInput(input, corpus, registry)).status, "changed");
    const different = createCaptureProvenance(capture, { ...extractor, dependencyLock: hash("different lock") });
    strict.deepEqual(
      (await verifyCaptureInput({ ...input, provenance: different }, corpus, registry)).changedCategories,
      ["provenance"],
    );
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-provenance-"));
    try {
      const file = join(directory, "corpus.json");
      await writeCorpus(corpus, file, registry);
      const restored = await readCorpus(file, registry);
      const model = importLegacyCorpus(restored, registry, options);
      const source = Object.values(model.sources)[0]!;
      strict.deepEqual(source.extractor, {
        status: "known",
        value: { id: extractor.id, revision: provenance.extractor.revision },
      });
      strict.equal(source.license.status, "unknown");
      strict.deepEqual(source.provenance, provenance);
      const legacy = createCatalog([capture], registry, options);
      strict.equal(Object.values(legacy.sources)[0]!.extractor.status, "unknown");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("captures exact tool files and dependency bytes without interpreting grammar IDs", async () => {
    const input = { dialect: "postgres", target: { version: "18.6" }, categories: categories() };
    const provenance = await attachNativeProvenance(input);
    strict.ok(provenance.extractor.files["scripts/language-audit/inventory.mjs"]);
    strict.ok(provenance.extractor.files["tools/grammar-catalog/src/mappers/postgres.mjs"]);
    strict.equal(provenance.extractor.runtime.version, process.version);
    validateCaptureProvenance(provenance, {
      grammar: input.dialect,
      target: input.target,
      categories: input.categories,
    });
  });
});
