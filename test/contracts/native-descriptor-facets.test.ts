import { describe, it, strict } from "poku";
import type { NativeContractValueEvidence } from "../../packages/analysis/src/index.js";
import { contractNativeFacetStatus } from "../../packages/analysis/src/qualification-model.js";
import { summarizeNativeDescriptorFacets } from "../../scripts/vocabulary/native-descriptor-facets.mjs";

const field: NativeContractValueEvidence = {
  nativeType: { status: "known", value: { name: "future_vendor_type(17)", complete: false } },
  runtimeType: { status: "unknown", reason: "codec-not-qualified" },
  nullable: { status: "known", value: true, precision: "upper-bound" },
  descriptor: { futureFacet: 17 },
};

await describe("native descriptor facet accounting", async () => {
  await it("counts actual field occurrences without a grammar or type-name allowlist", () => {
    const result = summarizeNativeDescriptorFacets({
      fields: { future: field },
      observations: [
        { status: "acquired", columns: ["future"], parameters: [] },
        { adapter: { status: "acquired", columns: ["future"], parameters: ["future"] } },
        { adapter: { status: "partial" } },
        { status: "declined" },
        { status: "future-unavailable-outcome" },
      ],
    });
    strict.deepEqual(result.outcomes, { acquired: 2, partial: 1, declined: 1, "future-unavailable-outcome": 1 });
    strict.equal(result.observations, 5);
    strict.equal(result.withoutFieldEvidence, 3);
    strict.equal(result.columns.occurrences, 2);
    strict.equal(result.columns.nativeType.partial, 2);
    strict.equal(result.columns.runtimeType.unavailable, 2);
    strict.equal(result.columns.nullable.upperBound, 2);
    strict.deepEqual(result.columns.reasons, { "runtimeType:codec-not-qualified": 2 });
    strict.equal(result.parameters.occurrences, 1);
    strict.equal(result.parameters.nativeType.partial, 1);
    strict.equal(result.parameters.runtimeType.unavailable, 1);
    strict.equal(result.parameters.nullable.upperBound, 1);
  });
  await it("distinguishes complete identities, runtime facts and exact nullability", () => {
    const result = summarizeNativeDescriptorFacets({
      fields: {
        known: {
          ...field,
          nativeType: { status: "known", value: { name: "future_vendor_type", complete: true } },
          runtimeType: { status: "known", value: "string" },
          nullable: { status: "known", value: false, precision: "exact" },
        },
        unknown: {
          ...field,
          nativeType: { status: "unknown", reason: "missing-native-identity" },
          runtimeType: { status: "known", value: "unknown" },
          nullable: { status: "unknown", reason: "no-native-nullability" },
        },
        nullable: { ...field, nullable: { status: "known", value: true, precision: "exact" } },
        nonNullBound: { ...field, nullable: { status: "known", value: false, precision: "upper-bound" } },
      },
      observations: [{ status: "acquired", columns: ["known", "unknown", "nullable", "nonNullBound"], parameters: [] }],
    });
    strict.deepEqual(result.columns.nativeType, { complete: 1, partial: 2, unavailable: 1 });
    strict.deepEqual(result.columns.runtimeType, { known: 1, unavailable: 3 });
    strict.deepEqual(result.columns.nullable, { exactNonNull: 2, exactNullable: 1, upperBound: 0, unavailable: 1 });
    strict.deepEqual(result.columns.reasons, {
      "nativeType:missing-native-identity": 1,
      "nullable:no-native-nullability": 1,
      "runtimeType:codec-not-qualified": 2,
    });
  });
  await it("rejects missing, unacquired or unaccounted evidence", () => {
    for (const observation of [
      { status: "acquired", columns: ["missing"], parameters: [] },
      { status: "acquired", columns: [] },
      { status: "partial", columns: ["future"], parameters: [] },
    ])
      strict.throws(() => summarizeNativeDescriptorFacets({ fields: { future: field }, observations: [observation] }));
    for (const invalid of [
      { ...field, newUnaccountedFacet: true },
      { ...field, nullable: { status: "known", value: true, precision: "invented" } },
      { ...field, runtimeType: { status: "unknown", reason: "" } },
    ])
      strict.throws(() =>
        summarizeNativeDescriptorFacets({
          fields: { future: invalid as NativeContractValueEvidence },
          observations: [{ status: "acquired", columns: ["future"], parameters: [] }],
        }),
      );
  });
  await it("discovers policy groups from observations instead of combining their authority", () => {
    const result = summarizeNativeDescriptorFacets({
      fields: { future: field },
      observations: [
        { policy: "future-policy", status: "acquired", columns: ["future"], parameters: [] },
        { policy: "unavailable-policy", status: "unavailable" },
      ],
    });
    strict.deepEqual(Object.keys(result.byPolicy), ["future-policy", "unavailable-policy"]);
    strict.equal(result.byPolicy["future-policy"]!.columns.occurrences, 1);
    strict.equal(result.byPolicy["unavailable-policy"]!.withoutFieldEvidence, 1);
    strict.equal(result.byPolicy["unavailable-policy"]!.columns.occurrences, 0);
    strict.throws(() =>
      summarizeNativeDescriptorFacets({
        fields: {},
        observations: [{ policy: "known-policy", status: "unavailable" }, { status: "unavailable" }],
      }),
    );
  });
  await it("agrees with qualification for every native/runtime/nullability state combination", () => {
    const unknown = { status: "unknown" as const, reason: "not-qualified" };
    const nativeTypes = [
      ...[true, false].map((complete) => ({ status: "known" as const, value: { name: "future_type", complete } })),
      unknown,
    ];
    const runtimeTypes = [
      ...(["string", "unknown", "never"] as const).map((value) => ({ status: "known" as const, value })),
      unknown,
    ];
    const nullabilities = [
      ...[true, false].flatMap((value) =>
        (["exact", "upper-bound"] as const).map((precision) => ({ status: "known" as const, value, precision })),
      ),
      unknown,
    ];
    for (const nativeType of nativeTypes)
      for (const runtimeType of runtimeTypes)
        for (const nullable of nullabilities) {
          const value = { nativeType, runtimeType, nullable, descriptor: {} };
          const result = summarizeNativeDescriptorFacets({
            fields: { value },
            observations: [{ status: "acquired", columns: ["value"], parameters: [] }],
          }).columns;
          const native = contractNativeFacetStatus(value, "native-type");
          const runtime = contractNativeFacetStatus(value, "runtime-type");
          const nullability = contractNativeFacetStatus(value, "nullability");
          strict.equal(result.nativeType[native === "unknown" ? "unavailable" : native], 1);
          strict.equal(result.runtimeType[runtime === "complete" ? "known" : "unavailable"], 1);
          strict.equal(
            nullability === "complete"
              ? result.nullable.exactNonNull + result.nullable.exactNullable
              : result.nullable[nullability === "partial" ? "upperBound" : "unavailable"],
            1,
          );
        }
  });
});
