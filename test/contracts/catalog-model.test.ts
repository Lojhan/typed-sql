import { describe, it, strict } from "poku";
import { readCorpus } from "../../scripts/catalog-generation/corpus.mjs";
import { CATEGORIES, inventory, unavailable } from "../../scripts/language-audit/inventory.mjs";
import { importLegacyCorpus } from "../../tools/grammar-catalog/src/import/legacy.mjs";
import { builtinMappers } from "../../tools/grammar-catalog/src/mappers/index.mjs";
import { createCatalog } from "../../tools/grammar-catalog/src/model/build.mjs";
import { hash } from "../../tools/grammar-catalog/src/model/canonical.mjs";
import { groupCatalog } from "../../tools/grammar-catalog/src/model/groups.mjs";
import { parseCatalog } from "../../tools/grammar-catalog/src/model/schema.mjs";
import { createMapperRegistry, numericVersionBand } from "../../tools/grammar-catalog/src/registry.mjs";

type Catalog = ReturnType<typeof parseCatalog>;
type IsAny<T> = 0 extends 1 & T ? true : false;
type Routine = NonNullable<Catalog["entities"][string]["routine"]>;
const entityIsAny: IsAny<Catalog["entities"][string]> = false;
const routineIsAny: IsAny<Routine> = false;
void entityIsAny;
void routineIsAny;
// The executable schema supplies literal/discriminated TypeScript types as well as runtime checks.
// @ts-expect-error The new model cannot silently accept the legacy envelope.
const oldFormat: Catalog["formatVersion"] = 1;
void oldFormat;
// @ts-expect-error Proven nullability is boolean, never a truthy source string.
const invalidNullability: Routine["result"]["nullable"] = { status: "known", value: "false" };
void invalidNullability;

const fixtureMapper = {
  id: "external",
  versionBand: numericVersionBand(2),
  normalizeRow: (_category: string, row: unknown) => row,
  parameterMode: () => "input",
  routineFacts: () => ({
    parameters: [
      {
        position: 1,
        inputPosition: 1,
        name: "graph",
        mode: "input",
        nativeType: "vertex",
        hasDefault: true,
        defaultExpression: "default_graph()",
      },
    ],
    resultColumns: [{ name: "vertex", nativeType: "vertex", nullable: null, vendorFact: "retained" }],
    result: "vertex",
    returnsSet: true,
  }),
};
const registry = createMapperRegistry([fixtureMapper]);
const options = {
  requiredCategories: ["functions", "types"],
  normalizerDigest: hash("test-normalizer"),
  inputDigest: hash("test-source"),
  sourceLocation: "urn:test:catalog",
};
const capture = (version = "1.2.3", extra = false) => ({
  grammar: "external",
  target: { version, mode: "graph" },
  categories: {
    functions: inventory(
      [
        { name: "vertices", namespace: "graph", vendorFact: { preserves: [1, true, null] } },
        ...(extra ? [{ name: "edges", namespace: "graph", vendorFact: { preserves: [2] } }] : []),
      ],
      "native fixture",
    ),
    types: unavailable("No native type inventory supplied"),
  },
});
const fixture = () => createCatalog([capture()], registry, options);

await describe("validated provenance-rich catalog model", async () => {
  await it("retains typed defaults/output schemas and explicit unknowns for external contributions", () => {
    const model = fixture();
    const entity = Object.values(model.entities)[0]!;
    strict.equal(entity.grammar, "external");
    strict.deepEqual(entity.native.vendorFact, { preserves: [1, true, null] });
    const routine = entity.routine!;
    if (routine.parameters.status !== "known" || routine.result.columns.status !== "known")
      throw new Error("Expected captured formal parameters and fixed output columns");
    strict.deepEqual(routine.parameters.value[0]!.default, { kind: "expression", sql: "default_graph()" });
    strict.equal(routine.parameters.value[0]!.mode, "input");
    strict.deepEqual(routine.result.columns.value[0]!.native.vendorFact, "retained");
    strict.equal(routine.result.nullable.status, "unknown");
    strict.equal(routine.invocation.status, "unknown");
    strict.equal(Object.values(model.sources)[0]!.extractor.status, "unknown");
    strict.deepEqual(parseCatalog(JSON.parse(JSON.stringify(model))), model);
    strict.equal(hash(fixture()), hash(model));
  });

  await it("keeps common and profile-specific facts with their memberships instead of dropping disagreements", () => {
    const model = createCatalog([capture(), capture("1.2.4", true)], registry, options);
    const [group] = groupCatalog(model);
    strict.equal(group.categories.functions.common.length, 1);
    strict.equal(group.categories.functions.variants.length, 1);
    strict.equal(group.categories.functions.common[0].profiles.length, 2);
    strict.equal(group.categories.functions.variants[0].profiles.length, 1);
    strict.equal(group.categories.types.unavailable.length, 2);
    strict.equal(Object.keys(model.entities).length, 2);
    strict.throws(() => createCatalog([capture(), capture()], registry, options), /Duplicate catalog profile/u);
  });

  await it("rejects forged hashes, mismatched references, missing scope and orphaned data", () => {
    const corrupt = (mutate: (model: Catalog) => void, pattern: RegExp) => {
      const model = fixture();
      mutate(model);
      strict.throws(() => parseCatalog(model), pattern);
    };
    corrupt((model) => {
      Object.values(model.entities)[0]!.name = "forged";
    }, /digest differs/u);
    corrupt((model) => {
      const old = Object.keys(model.entities)[0]!;
      const entity = model.entities[old]!;
      entity.semantic = { kind: "syntax", production: { status: "unknown", reason: "wrong category" } };
      const replacement = hash(entity);
      delete model.entities[old];
      model.entities[replacement] = entity;
      for (const profile of Object.values(model.profiles))
        for (const category of Object.values(profile.categories))
          if (category.status === "observed")
            for (const entry of category.entries) if (entry.entity === old) entry.entity = replacement;
    }, /Incompatible semantic facet/u);
    corrupt((model) => {
      delete model.sources[Object.keys(model.sources)[0]!];
    }, /Missing catalog source/u);
    corrupt((model) => {
      delete model.entities[Object.keys(model.entities)[0]!];
    }, /catalog entity/u);
    corrupt((model) => {
      delete Object.values(model.profiles)[0]!.categories.types;
    }, /Missing catalog category/u);
    corrupt((model) => {
      model.schemaDigest = hash("wrong schema");
    }, /schema digest/u);
    corrupt((model) => {
      Object.values(model.profiles)[0]!.version = "9.9";
    }, /profile identity/u);
    corrupt((model) => {
      const category = Object.values(model.profiles)[0]!.categories.functions!;
      if (category.status === "observed") category.originalFingerprint = hash("forged evidence");
    }, /source evidence/u);
    corrupt((model) => {
      const category = Object.values(model.profiles)[0]!.categories.functions!;
      if (category.status === "observed") category.entries.push(category.entries[0]!);
    }, /Duplicate native row/u);
    corrupt((model) => {
      const orphan = { ...Object.values(model.entities)[0]!, name: "orphan" };
      model.entities[hash(orphan)] = orphan;
    }, /orphaned/u);
    strict.throws(() => parseCatalog({ ...fixture(), unsupported: "discarded field" }), /Invalid catalog model/u);
  });

  await it("refuses non-JSON or cyclic metadata rather than losing it while hashing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const [bad, pattern] of [
      [cyclic, /cyclic/u],
      [new Date(), /non-JSON object/u],
      [NaN, /non-JSON/u],
      [undefined, /non-JSON/u],
      [new Array(1), /sparse/u],
      [Object.defineProperty({}, "hidden", { value: 1 }), /non-JSON properties/u],
      [
        Object.defineProperty({}, "getter", {
          enumerable: true,
          get: () => {
            throw new Error("Must not execute");
          },
        }),
        /accessor/u,
      ],
    ] as const)
      strict.throws(() => parseCatalog({ ...fixture(), bad }), pattern);
  });

  await it("accounts for every retained native category and row across all engines without a hand-written target list", async () => {
    const corpus = await readCorpus();
    const model = importLegacyCorpus(corpus, builtinMappers, {
      requiredCategories: CATEGORIES,
      normalizerDigest: hash("test"),
    });
    strict.equal(Object.keys(model.profiles).length, Object.keys(corpus.targets).length);
    const pragmas = Object.values(model.entities).filter(
      (entry) => entry.routine?.nativeKind.status === "known" && entry.routine.nativeKind.value === "pragma",
    );
    strict.ok(pragmas.length > 0);
    strict.ok(pragmas.every((entry) => entry.routine!.result.returnsSet.status === "unknown"));
    for (const entry of Object.values(corpus.targets) as {
      dialect: string;
      target: Record<string, unknown>;
      categories: Record<string, { status: string; fingerprint?: string; reason?: string }>;
    }[]) {
      const profile = model.profiles[hash({ grammar: entry.dialect, target: entry.target })]!;
      strict.deepEqual(Object.keys(profile.categories).sort(), [...CATEGORIES].sort());
      for (const [name, native] of Object.entries(entry.categories)) {
        const actual = profile.categories[name]!;
        strict.equal(actual.status, native.status);
        if (actual.status === "unavailable") strict.equal(actual.reason, native.reason);
        else {
          const rowIds = corpus.inventories[native.fingerprint!] as string[];
          strict.deepEqual(
            actual.entries.map((row) => row.rawRow),
            rowIds,
          );
          strict.equal(actual.originalFingerprint, native.fingerprint);
          strict.equal(model.sources[actual.source]!.contentDigest, native.fingerprint);
        }
      }
    }
  });
});
