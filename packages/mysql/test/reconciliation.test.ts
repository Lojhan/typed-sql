import {
  createStaticQueryClaim,
  type NativeContractValueEvidence,
  type StaticContractField,
} from "@typed-sql/analysis";
import { unknownQuerySemantics } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { mySqlContractIdentity, validateMySqlContractPolicy } from "../src/contract-profile.js";
import { createMySqlContractReconciler } from "../src/reconciliation.js";
import { defaultMySqlTypePolicy } from "../src/type-policy.js";

const owner = createMySqlContractReconciler();
const native: NativeContractValueEvidence = {
  nativeType: { status: "known", value: { name: "int", complete: true } },
  runtimeType: { status: "known", value: "number" },
  nullable: { status: "known", value: false, precision: "exact" },
  descriptor: {},
};
const expected: StaticContractField = { databaseType: "int", tsType: "number", nullable: false };
const compare = (
  facet: "native-type" | "runtime-type" | "nullability",
  changes: Partial<NativeContractValueEvidence> = {},
  claim: StaticContractField = expected,
  target: "column" | "parameter" = "column",
) => owner.compare({ facet, index: 1, target, expected: claim, native: { ...native, ...changes } });
await describe("MySQL independent contract reconciliation", async () => {
  await it("compares available claims and rejects contradictory application/codec metadata", () => {
    for (const facet of ["native-type", "runtime-type", "nullability"] as const)
      strict.equal(compare(facet).status, "compatible");
    strict.equal(compare("runtime-type", {}, { ...expected, tsType: "string" }).status, "conflict");
    strict.equal(compare("runtime-type", {}, { ...expected, runtimeType: "string" }).status, "conflict");
    strict.equal(compare("runtime-type", { runtimeType: { status: "known", value: "string" } }).status, "conflict");
    strict.equal(
      compare("native-type", { nativeType: { status: "known", value: { name: "bigint", complete: true } } }).status,
      "conflict",
    );
    strict.equal(
      compare("nullability", { nullable: { status: "known", value: true, precision: "exact" } }).status,
      "conflict",
    );
  });
  await it("keeps missing representation, dimensions and nullability conservative", () => {
    strict.equal(compare("runtime-type", {}, { tsType: "unknown", nullable: true }).staticStatus, "unknown");
    strict.equal(compare("runtime-type", { runtimeType: { status: "unknown", reason: "missing" } }).status, "widened");
    strict.equal(compare("native-type", { nativeType: { status: "unknown", reason: "missing" } }).status, "widened");
    strict.equal(
      compare("native-type", { nativeType: { status: "known", value: { name: "varchar", complete: false } } }).status,
      "conflict",
    );
    strict.equal(
      compare("native-type", {}, { tsType: "string", nullable: true, databaseType: "decimal" }).staticStatus,
      "partial",
    );
    strict.equal(compare("nullability", { nullable: { status: "unknown", reason: "missing" } }).status, "widened");
    strict.equal(
      compare(
        "native-type",
        { nativeType: { status: "known", value: { name: "varchar", complete: false } } },
        { databaseType: "char(24)", tsType: "string", nullable: false },
      ).status,
      "widened",
    );
    strict.equal(
      compare(
        "native-type",
        { nativeType: { status: "known", value: { name: "vector", complete: false } } },
        { databaseType: "vector", tsType: "Uint8Array", nullable: false },
      ).status,
      "widened",
    );
    strict.equal(
      compare(
        "native-type",
        { nativeType: { status: "known", value: { name: "decimal(12,3)", complete: true } } },
        { databaseType: "decimal", tsType: "string", nullable: false },
      ).status,
      "widened",
    );
  });
  await it("qualifies decimal input bounds directionally without generalizing result identities", () => {
    const input = { databaseType: "decimal(12,3)", tsType: "string", nullable: true };
    const evidence = { nativeType: { status: "known" as const, value: { name: "decimal(65,30)", complete: true } } };
    strict.equal(compare("native-type", evidence, input, "parameter").status, "compatible");
    strict.equal(compare("native-type", evidence, input, "column").status, "conflict");
    strict.equal(
      compare("native-type", evidence, { ...input, databaseType: "decimal(65,0)" }, "parameter").status,
      "conflict",
    );
  });
  await it("binds identities to valid decoding policies and keeps invalid SQL blocking", () => {
    strict.notDeepEqual(
      mySqlContractIdentity(),
      mySqlContractIdentity({ ...defaultMySqlTypePolicy, bigint: "string" }),
    );
    strict.throws(() => validateMySqlContractPolicy({ ...defaultMySqlTypePolicy, unknown: "any" } as never));
    const claim = createStaticQueryClaim({
      sql: "SELECT 1",
      context: {
        grammar: owner.grammar,
        ...mySqlContractIdentity(),
        schemaHash: "0".repeat(64),
        databaseContextHash: "0".repeat(64),
        typePolicyHash: "0".repeat(64),
      },
      analysis: {
        semantics: unknownQuerySemantics({ start: 0, end: 1, line: 1, column: 1 }, "Invalid fixture"),
        columns: [],
        parameters: [],
        diagnostics: [
          { code: "TSQ227", severity: "error", message: "invalid", range: { start: 0, end: 1, line: 1, column: 1 } },
        ],
      },
    });
    strict.equal(owner.classify(claim).status, "invalid");
  });
});
