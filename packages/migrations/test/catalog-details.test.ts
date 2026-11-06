import { describe, it, strict } from "poku";
import { type CatalogEvidence, catalogChanges, parseCatalog } from "../src/index.js";

const catalog: CatalogEvidence = {
  formatVersion: 1,
  dialect: "postgres",
  serverMajor: "18",
  namespaces: ["public"],
  coverage: "complete",
  objects: { column: { definitionHash: "before" } },
};
await describe("optional historical catalog details", async () => {
  await it("accepts hash-only history and treats details as display evidence rather than drift fingerprints", () => {
    strict.equal(parseCatalog(catalog), catalog);
    const detailed = {
      ...catalog,
      details: { column: { formatVersion: 1, kind: "column", properties: { type: "integer", notNull: true } } },
    };
    strict.equal(parseCatalog(detailed), detailed);
    strict.deepEqual(catalogChanges(catalog, detailed), []);
    strict.deepEqual(
      catalogChanges(detailed, { ...detailed, details: { column: { properties: { type: "text" } } } }),
      [],
    );
    strict.deepEqual(catalogChanges(detailed, { ...detailed, objects: { column: { definitionHash: "after" } } }), [
      { kind: "changed", object: "column" },
    ]);
  });
  await it("rejects malformed, non-JSON or dangling display evidence", () => {
    for (const details of [
      null,
      [],
      "text",
      { missing: {} },
      { column: undefined },
      { column: NaN },
      { column: new Date() },
    ])
      strict.throws(() => parseCatalog({ ...catalog, details }));
  });
});
