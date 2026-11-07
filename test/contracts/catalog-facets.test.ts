import { describe, it, strict } from "poku";
import { readCorpus } from "../../scripts/catalog-generation/corpus.mjs";
import { normalizedCorpus } from "../../scripts/catalog-generation/model.mjs";
import { duckdbEntityFacts } from "../../tools/grammar-catalog/src/mappers/facets/duckdb.mjs";
import { mysqlEntityFacts } from "../../tools/grammar-catalog/src/mappers/facets/mysql.mjs";
import { postgresEntityFacts } from "../../tools/grammar-catalog/src/mappers/facets/postgres.mjs";
import { describeEntity, field } from "../../tools/grammar-catalog/src/model/facets.mjs";
import type { parseCatalog } from "../../tools/grammar-catalog/src/model/schema.mjs";

type Facet = ReturnType<typeof parseCatalog>["entities"][string]["semantic"];
type IsAny<T> = 0 extends 1 & T ? true : false;
const isAny: IsAny<Facet> = false;
void isAny;
// @ts-expect-error Semantic discriminants remain statically checked.
const invalid: Facet = { kind: "made-up" };
void invalid;
const invalidKeyword: Facet = {
  kind: "keyword",
  spelling: "SELECT",
  // @ts-expect-error Reserved-word evidence must be boolean, not a driver string.
  reserved: { status: "known", value: "1" },
  nativeCategory: { status: "unknown", reason: "missing" },
};
void invalidKeyword;
await describe("typed catalog semantic facets", async () => {
  await it("accounts for every retained entity without discarding original native fields", async () => {
    const { catalog } = normalizedCorpus(await readCorpus());
    const kinds = new Set<string>();
    for (const entity of Object.values(catalog.entities)) {
      kinds.add(entity.semantic.kind);
      strict.ok(entity.native);
      if (entity.semantic.kind === "keyword") strict.equal(entity.semantic.spelling, entity.name.toUpperCase());
      if (entity.grammar === "mysql" && entity.name === "AUTO_INCREMENT" && entity.semantic.kind === "type")
        strict.equal(entity.semantic.canonical.kind, "unknown");
    }
    strict.deepEqual([...kinds].sort(), [
      "cast",
      "collation",
      "extension",
      "keyword",
      "operator",
      "routine",
      "setting",
      "syntax",
      "type",
    ]);
  });
  await it("distinguishes unavailable facts from false and validates wire fields", () => {
    strict.deepEqual(field({ flag: "0" }, "flag", "boolean"), { status: "known", value: false });
    strict.equal(field({}, "flag", "boolean").status, "unknown");
    strict.throws(() => field({ flag: "false" }, "flag", "boolean"), /Invalid/u);
    strict.throws(() => field({ width: "" }, "width", "integer"), /Invalid/u);
    strict.deepEqual(field({ options: [""] }, "options", "texts"), { status: "known", value: [""] });
    strict.equal(describeEntity("unfamiliar", "entity").kind, "unknown");
  });
  await it("does not promote negative implicit-cast observations or help topics into unsupported facts", () => {
    const cast = describeEntity("casts", "a -> b", duckdbEntityFacts("casts", { name: "a -> b", implicit: false }));
    strict.equal(cast.context.status, "unknown");
    strict.equal(
      describeEntity("types", "AUTO_INCREMENT", mysqlEntityFacts("types", { name: "AUTO_INCREMENT" })).canonical.kind,
      "unknown",
    );
    strict.equal(
      describeEntity("operators", "+", postgresEntityFacts("operators", { name: "+" })).fixity.status,
      "unknown",
    );
    strict.deepEqual(
      postgresEntityFacts("operators", { name: "-", left_type: "-", right_type: "integer", result: "integer" }).fixity,
      { status: "known", value: "prefix" },
    );
  });
});
