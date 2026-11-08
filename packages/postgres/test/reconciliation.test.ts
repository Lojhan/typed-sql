import { describe, it, strict } from "poku";
import type {
  createStaticQueryClaim,
  NativeContractValueEvidence,
  StaticContractField,
} from "../../analysis/src/index.js";
import { postgres } from "../src/index.js";
import { createPostgresContractReconciler } from "../src/reconciliation.js";

const schema = { formatVersion: 1, dialect: "postgres", tables: {} } as const;
const owner = createPostgresContractReconciler({ schema });
const known = <Value>(value: Value) => ({ status: "known" as const, value });
const unknown = { status: "unknown" as const, reason: "not-reported" };
const expected: StaticContractField = {
  tsType: "bigint",
  runtimeType: "bigint",
  databaseType: "bigint",
  nullable: false,
};
const native: NativeContractValueEvidence = {
  nativeType: known({ name: "bigint", complete: true }),
  runtimeType: known("bigint" as const),
  nullable: unknown,
  descriptor: { oid: 20 },
};
const compare = (
  facet: "native-type" | "runtime-type" | "nullability",
  left = expected,
  right = native,
  target: "column" | "parameter" = "column",
) => owner.compare({ facet, expected: left, native: right, target, index: 1 });
await describe("PostgreSQL independent contract reconciliation", async () => {
  await it("compares available representations and detects inconsistent static type/codec claims", () => {
    strict.equal(compare("runtime-type").status, "compatible");
    strict.equal(compare("runtime-type", { ...expected, runtimeType: "string", tsType: "string" }).status, "conflict");
    strict.equal(compare("runtime-type", { ...expected, tsType: "string" }).rule, "static-type-codec-conflict");
    strict.equal(
      compare("runtime-type", { ...expected, runtimeType: "unknown", tsType: "unknown" }).staticStatus,
      "unknown",
    );
    strict.equal(compare("runtime-type", expected, { ...native, runtimeType: unknown }).status, "widened");
    strict.equal(compare("runtime-type", { ...expected, tsType: "OpaqueApplicationType" }).status, "unavailable");
    strict.equal(
      compare("runtime-type", { ...expected, tsType: "unknown", runtimeType: { array: "bigint" } }).status,
      "unavailable",
    );
    const { runtimeType: _runtime, ...inferred } = expected;
    strict.equal(compare("runtime-type", inferred).status, "compatible");
  });
  await it("does not certify unavailable nullability or confuse a nullable upper bound with a contradiction", () => {
    strict.equal(compare("nullability").status, "widened");
    strict.equal(
      compare("nullability", expected, { ...native, nullable: { ...known(true), precision: "upper-bound" } }).status,
      "widened",
    );
    strict.equal(
      compare("nullability", expected, { ...native, nullable: { ...known(true), precision: "exact" } }).status,
      "conflict",
    );
    strict.equal(
      compare(
        "nullability",
        { ...expected, nullable: true },
        { ...native, nullable: { ...known(false), precision: "exact" } },
      ).status,
      "compatible",
    );
  });
  await it("compares pinned aliases and families without inventing modifier or opaque-type compatibility", () => {
    strict.equal(compare("native-type").status, "compatible");
    strict.equal(compare("native-type", { ...expected, databaseType: "int8" }).status, "compatible");
    strict.equal(compare("native-type", { ...expected, databaseType: "text" }).status, "conflict");
    strict.equal(compare("native-type", { ...expected, databaseType: "bigint[]" }).status, "conflict");
    const { databaseType: _databaseType, ...missing } = expected;
    strict.equal(compare("native-type", missing).staticStatus, "unknown");
    strict.equal(compare("native-type", expected, { ...native, nativeType: unknown }).status, "widened");
    strict.equal(compare("native-type", { ...expected, databaseType: "public.custom" }).status, "unavailable");
    strict.equal(
      compare(
        "native-type",
        { ...expected, databaseType: "float(24)" },
        { ...native, nativeType: known({ name: "real", complete: true }) },
      ).status,
      "unavailable",
    );
    const decimal: NativeContractValueEvidence = {
      ...native,
      nativeType: known({ name: "numeric(10,2)", complete: true }),
    };
    strict.equal(compare("native-type", { ...expected, databaseType: "decimal(10,2)" }, decimal).status, "compatible");
    strict.equal(compare("native-type", { ...expected, databaseType: "numeric(9,2)" }, decimal).status, "unavailable");
    strict.equal(
      compare("native-type", { ...expected, databaseType: "numeric", databaseTypeIsPartial: true }, decimal).status,
      "compatible",
    );
    strict.equal(
      compare(
        "native-type",
        { ...expected, databaseType: "numeric(9,2)" },
        { ...decimal, nativeType: known({ name: "numeric", complete: false }) },
        "parameter",
      ).staticStatus,
      "partial",
    );
  });
  await it("retains invalidity diagnostics even when a native description succeeds", () => {
    const analysis = postgres().analyze("SELECT missing FROM absent", schema);
    // The classifier consumes only normalized diagnostic codes, not arbitrary source messages.
    const claim = { diagnostics: analysis.diagnostics } as unknown as ReturnType<typeof createStaticQueryClaim>;
    strict.equal(owner.classify(claim).status, "invalid");
    strict.equal(
      owner.classify({ diagnostics: [] } as unknown as ReturnType<typeof createStaticQueryClaim>).status,
      "resolved",
    );
  });
});
