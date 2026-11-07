import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { addCapture, emptyCorpus, verifyCaptureInput } from "../../scripts/catalog-generation/corpus.mjs";
import { normalizedCorpus } from "../../scripts/catalog-generation/model.mjs";
import { builtinDiscoveryRegistry } from "../../scripts/language-audit/discovery/index.mjs";
import { createDiscoveryRegistry } from "../../scripts/language-audit/discovery/registry.mjs";
import { CATEGORIES, collectLive, diffInventory, inventory } from "../../scripts/language-audit/inventory.mjs";
import { reviewLive } from "../../scripts/language-audit/live-baseline.mjs";
import { attachNativeProvenance } from "../../scripts/language-audit/provenance.mjs";
import { numericVersionBand } from "../../tools/grammar-catalog/src/registry.mjs";

const external = {
  id: "vendor",
  versionBand: numericVersionBand(1),
  normalizeRow: (_category: string, row: unknown) => row,
  routineFacts: () => ({ parameters: [], result: "node" }),
  discoveryQueries: () => ({ functions: "ENUMERATE GRAPH ROUTINES", types: "ENUMERATE GRAPH TYPES" }),
  discoveryRow: (_category: string, row: { name: string }) => ({ name: row.name }),
  discoveryScope: () => "graph-extension",
  discoveryLimitation: (category: string) => `Graph engine does not expose ${category}`,
  discoveryDerived: async () => {},
};
await describe("registered native discovery", async () => {
  await it("requires a discovery owner for every declared grammar without a second manual list", async () => {
    const ledger = JSON.parse(await readFile(new URL("../../grammar/features/ledger.json", import.meta.url), "utf8"));
    strict.deepEqual([...builtinDiscoveryRegistry.ids].sort(), Object.keys(ledger.dialects).sort());
    const source = await readFile(new URL("../../scripts/language-audit/inventory.mjs", import.meta.url), "utf8");
    strict.doesNotMatch(source, /\b(?:dialect|grammar)\s*(?:===?|!==?)\s*["'][a-z]/u);
  });
  await it("discovers and imports an inherited graph contribution through the real pipeline", async () => {
    const original = createDiscoveryRegistry([external]);
    const registry = original.extend([
      {
        id: "vendor/graph",
        extends: "vendor",
        discoveryDerived: async ({ categories }: { categories: Record<string, unknown> }) => {
          categories.keywords = inventory([{ name: "MATCH" }], "graph keyword API", "graph-extension");
        },
      },
    ]);
    const queries: string[] = [];
    const capture = await collectLive(
      "vendor/graph",
      async (sql: string) => {
        queries.push(sql);
        return [{ name: sql.includes("ROUTINES") ? "vertices" : "node", secret: "discarded" }];
      },
      { version: "1.2.3" },
      registry,
    );
    strict.deepEqual(queries, ["ENUMERATE GRAPH ROUTINES", "ENUMERATE GRAPH TYPES"]);
    strict.equal(Object.keys(capture.categories).length, CATEGORIES.length);
    strict.ok(!JSON.stringify(capture).includes("discarded"));
    strict.equal(capture.categories.functions?.scope, "graph-extension");
    strict.equal(capture.categories.keywords?.status, "observed");
    await attachNativeProvenance(capture, registry);
    const corpus = emptyCorpus();
    await addCapture(corpus, capture, registry);
    strict.equal((await verifyCaptureInput(capture, corpus, registry)).status, "match");
    const model = normalizedCorpus(corpus, registry).catalog;
    const review = reviewLive(capture, { targets: {} }, registry);
    strict.equal(review.status, "review-required");
    strict.equal(reviewLive(capture, { targets: { [review.key]: review.summary } }, registry).status, "match");
    strict.deepEqual(diffInventory(capture, capture, registry), []);
    strict.equal(Object.values(model.profiles)[0]?.grammar, "vendor/graph");
    strict.ok(Object.values(model.sources).every((source) => source.extractor.status === "known"));
    strict.deepEqual(original.ids, ["vendor"]);
  });
  await it("rejects invalid plans and malformed derived evidence before exposing a capture", async () => {
    for (const discoveryQueries of [() => ({ unknown: "SELECT x" }), () => ({ types: "" })]) {
      const registry = createDiscoveryRegistry([{ ...external, discoveryQueries }]);
      await strict.rejects(
        collectLive(
          "vendor",
          async () => {
            throw new Error("must not execute");
          },
          { version: "1" },
          registry,
        ),
        /Invalid discovery query/u,
      );
    }
    const registry = createDiscoveryRegistry([
      {
        ...external,
        discoveryDerived: async ({ categories }: { categories: Record<string, unknown> }) => {
          categories.types = { status: "observed", rows: [], fingerprint: "forged" };
        },
      },
    ]);
    await strict.rejects(
      collectLive("vendor", async () => [{ name: "node" }], { version: "1" }, registry),
      /Invalid discovered inventory/u,
    );
    strict.throws(() => createDiscoveryRegistry([{ id: "missing" }]), /Missing/u);
  });
  await it("propagates DuckDB connection failures while deriving native casts", async () => {
    const mapper = builtinDiscoveryRegistry.get("duckdb");
    await strict.rejects(
      mapper.discoveryDerived({
        categories: { types: inventory([{ name: "INTEGER" }], "types") },
        query: async () => {
          throw new Error("connection lost");
        },
      }),
      /connection lost/u,
    );
  });
});
