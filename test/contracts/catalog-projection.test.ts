import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { readCorpus } from "../../scripts/catalog-generation/corpus.mjs";
import { normalizedCorpus } from "../../scripts/catalog-generation/model.mjs";
import {
  postgresSemanticCasts,
  postgresSemanticSignature,
  postgresSemanticTypes,
} from "../../tools/grammar-catalog/src/generate/facts/postgres-semantic.mjs";
import {
  sqlServerSemanticTypeSource,
  sqlServerTypeSource,
} from "../../tools/grammar-catalog/src/generate/sqlserver-types.mjs";
import { groupCatalog } from "../../tools/grammar-catalog/src/model/groups.mjs";
import { commonEntities, nativeIdentity, requireKnown } from "../../tools/grammar-catalog/src/model/projection.mjs";

await describe("validated catalog projections", async () => {
  await it("uses semantic facts and never recovers missing facts from opaque native payloads", async () => {
    const { catalog } = normalizedCorpus(await readCorpus());
    const policy = JSON.parse(
      await readFile(new URL("../../grammar/postgres/catalog/core.json", import.meta.url), "utf8"),
    );
    for (const group of groupCatalog(catalog).filter((group) => group.grammar === "postgres")) {
      const signatureEntities = commonEntities(group, "functions");
      for (const entity of signatureEntities)
        strict.deepEqual(
          postgresSemanticSignature({ ...entity, native: { forged: true } }),
          postgresSemanticSignature(entity),
        );
      const policies = policy.types.filter(
        (entry: { introduced: number; removed?: number }) =>
          entry.introduced <= Number(group.band) && (entry.removed === undefined || Number(group.band) < entry.removed),
      );
      const expectedTypes = postgresSemanticTypes(commonEntities(group, "types"), policies, policy.typeCategories);
      const types = postgresSemanticTypes(
        commonEntities(group, "types").map((entity) => ({ ...entity, native: {} })),
        policies,
        policy.typeCategories,
      );
      strict.deepEqual(types, expectedTypes);
      strict.throws(
        () =>
          postgresSemanticTypes(
            commonEntities(group, "types").map((entity) => ({
              ...entity,
              semantic: { ...entity.semantic, defined: { status: "unknown", reason: "removed required proof" } },
            })),
            policies,
            policy.typeCategories,
          ),
        /Unqualified/u,
      );
      strict.throws(
        () =>
          postgresSemanticCasts(
            commonEntities(group, "casts").map((entity) => ({
              ...entity,
              semantic: { ...entity.semantic, context: { status: "unknown", reason: "removed required proof" } },
            })),
            types,
          ),
        /Unqualified/u,
      );

      strict.deepEqual(
        postgresSemanticCasts(
          commonEntities(group, "casts").map((entity) => ({ ...entity, native: {} })),
          types,
        ),
        postgresSemanticCasts(commonEntities(group, "casts"), types),
      );
    }
  });
  await it("rejects unavailable required facts and unsupported type expressions", () => {
    strict.throws(() => requireKnown({ status: "unknown", reason: "missing" }, "type category"), /Unqualified/u);
    strict.throws(
      () => nativeIdentity({ kind: "variable", name: "T", constraints: [] }, "cast endpoint"),
      /Unqualified/u,
    );
    strict.throws(
      () => commonEntities({ grammar: "external", band: "1", profiles: [], categories: {} }, "types"),
      /Unavailable/u,
    );
    strict.throws(
      () =>
        commonEntities(
          {
            grammar: "external",
            band: "1",
            profiles: [],
            categories: {
              types: { unavailable: [{ profile: "missing", reason: "missing" }], common: [], variants: [] },
            },
          },
          "types",
        ),
      /Unavailable/u,
    );
  });
  await it("requires SQL Server storage and dimension evidence without reading raw payloads", async () => {
    const { catalog } = normalizedCorpus(await readCorpus());
    const groups = groupCatalog(catalog).filter((group) => group.grammar === "sqlserver");
    const policy = JSON.parse(
      await readFile(new URL("../../grammar/sqlserver/catalog/policy.json", import.meta.url), "utf8"),
    );
    const baseline = sqlServerSemanticTypeSource(policy, groups, "");
    const poisoned = structuredClone(groups);
    for (const group of poisoned)
      for (const member of group.categories.types!.common)
        member.entity.native = { name: "forged", max_length: 0, system_type_id: 0 };
    strict.equal(sqlServerSemanticTypeSource(policy, poisoned, ""), baseline);
    for (const property of ["storageIdentity", "maxLength"] as const) {
      const missing = structuredClone(groups);
      for (const group of missing)
        for (const member of group.categories.types!.common) {
          const facet = member.entity.semantic;
          if (facet.kind !== "type") throw new Error("Unexpected type facet");
          const unknown = { status: "unknown" as const, reason: "withheld required evidence" };
          if (property === "storageIdentity") facet.storageIdentity = unknown;
          else facet.dimensions.maxLength = unknown;
        }
      strict.throws(() => sqlServerSemanticTypeSource(policy, missing, ""), /Unqualified/u);
    }
    strict.throws(
      () =>
        sqlServerTypeSource(
          { types: [] },
          [
            {
              dialect: "sqlserver",
              categories: {
                types: { rows: [{ name: "integer", system_type_id: 56, max_length: null, precision: 10, scale: 0 }] },
              },
            },
          ],
          "",
        ),
      /Unqualified/u,
    );
  });
});
