import type { NativeContractValueEvidence, StaticContractField } from "@typed-sql/analysis";
import { describe, it, strict } from "poku";
import { createDuckDBContractReconciler } from "../src/reconciliation.js";

const owner = createDuckDBContractReconciler();
const expected: StaticContractField = {
  tsType: "string",
  databaseType: "VARCHAR",
  runtimeType: "string",
  nullable: false,
};
const native: NativeContractValueEvidence = {
  nativeType: { status: "known", value: { name: "VARCHAR", complete: true } },
  runtimeType: { status: "known", value: "string" },
  nullable: { status: "unknown", reason: "prepare-does-not-establish-nullability" },
  descriptor: {},
};
const compare = (facet: "native-type" | "runtime-type" | "nullability", claim = expected, evidence = native) =>
  owner.compare({ target: "column", index: 1, facet, expected: claim, native: evidence });

await describe("DuckDB independent claim reconciliation", async () => {
  await it("detects disagreement between application, runtime and native type claims", () => {
    strict.equal(compare("runtime-type", { ...expected, tsType: "number" }).status, "conflict");
    strict.equal(compare("runtime-type", { ...expected, runtimeType: "number" }).status, "conflict");
    strict.equal(
      compare("runtime-type", expected, { ...native, runtimeType: { status: "known", value: "number" } }).status,
      "conflict",
    );
    strict.equal(
      compare("native-type", expected, {
        ...native,
        nativeType: { status: "known", value: { name: "BIGINT", complete: true } },
      }).status,
      "conflict",
    );
    strict.equal(compare("native-type", { ...expected, databaseTypeIsPartial: true }).staticStatus, "partial");
    strict.equal(compare("native-type").status, "compatible");
    strict.equal(compare("runtime-type").status, "compatible");
  });
  await it("keeps unknown static facets distinct from unsupported application representations", () => {
    strict.equal(compare("native-type", { tsType: "unknown", nullable: true }).staticStatus, "unknown");
    strict.equal(
      compare("native-type", { tsType: "unknown", databaseType: "ANY", nullable: true }).staticStatus,
      "unknown",
    );
    strict.equal(compare("runtime-type", { tsType: "unknown", nullable: true }).staticStatus, "unknown");
    strict.equal(compare("runtime-type", { tsType: "MyCustomType", nullable: true }).staticStatus, "known");
    strict.equal(
      compare("runtime-type", { tsType: "never", nullable: true, runtimeType: "never" }).staticStatus,
      "unknown",
    );
    strict.equal(
      compare("runtime-type", { tsType: "string", nullable: true, databaseType: "VARCHAR" }).status,
      "compatible",
    );
  });
  await it("widens unavailable native metadata and never retains an unverified non-null assertion", () => {
    strict.equal(
      compare("native-type", expected, { ...native, nativeType: { status: "unknown", reason: "unavailable" } }).status,
      "widened",
    );
    strict.equal(
      compare("runtime-type", expected, { ...native, runtimeType: { status: "unknown", reason: "unavailable" } })
        .status,
      "widened",
    );
    strict.equal(compare("nullability").status, "widened");
    strict.equal(
      compare("nullability", expected, {
        ...native,
        nullable: { status: "known", value: true, precision: "upper-bound" },
      }).status,
      "widened",
    );
    strict.equal(
      compare("nullability", expected, { ...native, nullable: { status: "known", value: true, precision: "exact" } })
        .status,
      "conflict",
    );
    strict.equal(
      compare(
        "nullability",
        { ...expected, nullable: true },
        { ...native, nullable: { status: "known", value: true, precision: "exact" } },
      ).status,
      "compatible",
    );
    strict.equal(
      compare("nullability", expected, { ...native, nullable: { status: "known", value: false, precision: "exact" } })
        .status,
      "compatible",
    );
  });
});
