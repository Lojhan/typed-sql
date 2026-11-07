import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { hash, inventory } from "../../scripts/language-audit/inventory.mjs";
import { recognitionRows } from "../../scripts/language-audit/recognition-reference.mjs";
import type { ReferenceSource } from "../../scripts/language-audit/reference-sources/contracts.js";
import { builtinReferenceSources } from "../../scripts/language-audit/reference-sources/index.js";
import { createReferenceSourceRegistry } from "../../scripts/language-audit/reference-sources/registry.js";
import {
  extractFunctions,
  loadReferences,
  referenceTargets,
  refreshReferences,
} from "../../scripts/language-audit/references.js";
import { createMapperRegistry } from "../../tools/grammar-catalog/src/registry.mjs";
import { referenceDocument } from "../helpers/reference-documents.js";

const source: ReferenceSource = {
  id: "vendor/base",
  referenceVersions: () => ["1"],
  captureVersions: () => ["live"],
  minimumFunctions: 2,
  scope: "Independent reference names only; native semantics unqualified.",
  extractFunctions: (body, url) => JSON.parse(body).map((name: string) => ({ name, url })),
  async collect(_version, page) {
    const url = "https://sources.test/functions";
    return {
      functions: this.extractFunctions!(await page(url), url),
      categories: { types: inventory([{ name: "node" }], url, "reference-only") },
    };
  },
};

await describe("registered documentation reference sources", async () => {
  await it("uses registered version bands for native recognition fallback and inherited contributions", async () => {
    for (const [dialect, nativeVersion, version] of [
      ["postgres", "14.24", "14"],
      ["mysql", "8.4.11", "8.4"],
      ["sqlserver", "17.0.5035.5", "17"],
    ]) {
      const expected = JSON.parse(
        await readFile(new URL(`../fixtures/language-audit/${dialect}-${version}.json`, import.meta.url), "utf8"),
      );
      const rows = await recognitionRows({ dialect, target: { version: nativeVersion }, categories: {} });
      strict.deepEqual(rows, expected.categories.functions.rows);
    }
    const mappers = createMapperRegistry([{ id: "vendor/base", versionBand: () => "family" }], {
      methods: ["versionBand"],
    }).extend([{ id: "vendor/graph", extends: "vendor/base" }]);
    const input = {
      dialect: "vendor/graph",
      target: { version: "native-build" },
      categories: { functions: { scope: "system-objects-only", rows: [{ name: "system_object" }] } },
    };
    const reference = async (dialect: string, version: string) => ({
      dialect,
      target: { version },
      categories: { functions: { rows: [{ name: "graph_function" }] } },
    });
    strict.deepEqual(await recognitionRows(input, { mappers, reference }), [
      { name: "system_object" },
      { name: "graph_function" },
    ]);
    const retained = { ...input, categories: { functions: { scope: "engine", rows: [{ name: "native_function" }] } } };
    strict.strictEqual(
      await recognitionRows(retained, {
        mappers,
        reference: async () => {
          throw new Error("Unexpected fallback");
        },
      }),
      retained.categories.functions.rows,
    );
    await strict.rejects(
      recognitionRows(input, { mappers, reference: async () => reference("other", "family") }),
      /identity/u,
    );
  });
  await it("preserves the reviewed reference envelopes for every registered documentation target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-builtin-references-"));
    try {
      const review = JSON.parse(
        await readFile(
          new URL("../../planning/grammar-completeness/reference-owner-review.json", import.meta.url),
          "utf8",
        ),
      );
      const results = await refreshReferences({ directory, download: async (url) => referenceDocument(url) });
      const comparisons = results
        .map((result) => ({ file: `${result.dialect}-${result.target.version}.json`, digest: hash(result) }))
        .sort((a, b) => a.file.localeCompare(b.file));
      strict.equal(comparisons.length, review.targets);
      strict.deepEqual(comparisons, review.comparisons);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("refreshes and loads inherited graph references with injected mapping and shared download caching", async () => {
    const registry = createReferenceSourceRegistry([source]).extend([
      { id: "vendor/graph", extends: source.id, referenceVersions: () => ["2"], captureVersions: () => [] },
    ]);
    const mappers = createMapperRegistry([
      {
        id: source.id,
        versionBand: (version: string) => version,
        normalizeRow: (_category: string, row: unknown) => row,
        routineFacts: () => ({ parameters: null }),
      },
    ]).extend([{ id: "vendor/graph", extends: source.id }]);
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-reference-owners-"));
    try {
      let downloads = 0;
      const body = '["node","edge","node"]';
      const results = await refreshReferences({
        registry,
        mappers,
        directory,
        download: async () => {
          downloads++;
          return body;
        },
      });
      strict.equal(downloads, 1);
      strict.deepEqual(
        results.map(({ dialect, target }) => [dialect, target.version]),
        [
          [source.id, "1"],
          ["vendor/graph", "2"],
        ],
      );
      for (const result of results) {
        strict.deepEqual(result.sources, [{ url: "https://sources.test/functions", hash: hash(body) }]);
        strict.deepEqual(
          result.categories.functions.rows?.map(({ name }) => name),
          ["edge", "node"],
        );
        strict.equal(result.categories.functions.rows?.[0]?.signature.parameterKnowledge, "unavailable");
        strict.equal(result.scope, source.scope);
        strict.deepEqual(
          JSON.parse(await readFile(join(directory, `${result.dialect}-${result.target.version}.json`), "utf8")),
          result,
        );
      }
      const capture = { dialect: source.id, target: { version: "native" }, categories: {} };
      await mkdir(join(directory, "vendor"), { recursive: true });
      await writeFile(join(directory, "vendor/base-live.json"), JSON.stringify(capture));
      strict.deepEqual(await loadReferences({ registry, directory }), [...results, capture]);
      strict.deepEqual(extractFunctions("vendor/graph", '["custom"]', "test", registry), [
        { name: "custom", url: "test" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("snapshots caller policies and rejects invalid, ambiguous or missing source contracts", () => {
    const versions = ["1"];
    const definition = { ...source, referenceVersions: () => versions };
    const registry = createReferenceSourceRegistry([definition]);
    versions.push("2");
    definition.minimumFunctions = 99;
    const inherited = registry.extend([{ id: "vendor/graph", extends: source.id }]);
    strict.deepEqual(inherited.get(source.id).referenceVersions(), ["1"]);
    strict.equal(inherited.get("vendor/graph").minimumFunctions, 2);
    strict.throws(() => registry.get("missing"), /Unregistered/u);
    strict.throws(
      () => createReferenceSourceRegistry([{ ...source, referenceVersions: () => ["../unsafe"] }]),
      /versions/u,
    );
    strict.throws(() => createReferenceSourceRegistry([{ ...source, captureVersions: () => ["1"] }]), /Overlapping/u);
    const { collect: _collect, ...withoutCollector } = source;
    strict.throws(() => createReferenceSourceRegistry([withoutCollector]), /collector/u);
    strict.throws(() => createReferenceSourceRegistry([{ ...source, minimumFunctions: -1 }]), /policy/u);
    strict.throws(
      () =>
        createReferenceSourceRegistry([
          { id: "vendor/a", extends: "vendor/b" },
          { id: "vendor/b", extends: "vendor/a" },
        ]),
      /Cyclic/u,
    );
    strict.throws(() => extractFunctions("duckdb", "", ""), /No reference function extractor/u);
    strict.deepEqual(
      referenceTargets()
        .map(({ dialect }) => dialect)
        .filter((id, index, ids) => ids.indexOf(id) === index),
      ["postgres", "mysql", "sqlite", "sqlserver"],
    );
    strict.deepEqual(builtinReferenceSources.get("duckdb").referenceVersions(), []);
  });

  await it("propagates upstream failures and rejects lost inventories and category replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-reference-failures-"));
    try {
      const registry = createReferenceSourceRegistry([source]);
      await strict.rejects(
        refreshReferences({
          registry,
          directory,
          download: async () => {
            throw new Error("upstream unavailable");
          },
        }),
        /upstream unavailable/u,
      );
      await strict.rejects(
        refreshReferences({ registry, directory, download: async () => "[]" }),
        /Suspiciously small/u,
      );
      const onlyInvalid = createReferenceSourceRegistry([
        {
          ...source,
          collect: async () => ({
            functions: [],
            categories: { functions: inventory([{ name: "forged" }], "forged") },
          }),
        },
      ]);
      await strict.rejects(refreshReferences({ registry: onlyInvalid, directory }), /Invalid reference category/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("fails closed on HTTP errors and redirects to a different manual", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-reference-http-"));
    const originalFetch = globalThis.fetch;
    const registry = createReferenceSourceRegistry([source]);
    try {
      globalThis.fetch = async () => new Response("unavailable", { status: 503 });
      await strict.rejects(refreshReferences({ registry, directory }), /503: https:\/\/sources.test/u);
      globalThis.fetch = async () => {
        const response = new Response('["node","edge"]');
        Object.defineProperty(response, "url", { value: "https://sources.test/another-version" });
        return response;
      };
      await strict.rejects(refreshReferences({ registry, directory }), /Unexpected upstream redirect/u);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
