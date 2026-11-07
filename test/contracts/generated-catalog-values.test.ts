import { createHash } from "node:crypto";
import { describe, it, strict } from "poku";
import { mySqlCatalogs } from "../../packages/mysql/src/catalog/generated/registry.js";
import { postgresCatalogs } from "../../packages/postgres/src/catalog/generated/registry.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

await describe("executed generated catalog value integrity", async () => {
  await it("retains every serialized field when checked literals become runtime objects", () => {
    for (const catalog of [...postgresCatalogs, ...mySqlCatalogs]) {
      const { revision, ...facts } = catalog;
      const actual = `sha256:${createHash("sha256")
        .update(JSON.stringify(canonical(facts)))
        .digest("hex")}`;
      strict.equal(actual, revision);
      strict.equal(catalog.formatVersion, 1);
    }
  });
});
