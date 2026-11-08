import { describe, it, strict } from "poku";
import { DIALECT_CONTRACT_VERSION, type DialectAnalysis, unknownQuerySemantics } from "../../core/src/index.js";
import { calculateSchemaHash, calculateTypePolicyHash } from "../../schema/src/index.js";
import {
  type ContractQualificationPolicy,
  type ContractReconciliationContribution,
  canonicalContractData,
  createContractDialect,
  createQueryContract,
  createStaticQueryClaim,
  type NativeContractValueEvidence,
  type NativeQueryContractEvidence,
  parseContractQualificationPolicy,
  parseQueryContract,
  parseQueryContractQualification,
  parseStaticQueryClaim,
  type QueryContractContext,
  queryContractDigest,
  reconcileQueryContract,
} from "../src/index.js";

const schema = { formatVersion: 1, dialect: "vendor/graph", tables: {} } as const;
const policy = { integer: "bigint" };
const context: QueryContractContext = {
  grammar: { id: schema.dialect, version: "1" },
  profileHash: queryContractDigest("profile"),
  schemaHash: calculateSchemaHash(schema),
  databaseContextHash: queryContractDigest("database"),
  typePolicyHash: calculateTypePolicyHash(policy),
  codecHash: queryContractDigest("codec"),
  interpreterHash: queryContractDigest("interpreter"),
};
const sql = "SELECT score($1) AS score",
  range = { start: 0, end: sql.length, line: 1, column: 1 };
const known = <Value>(value: Value) => ({ status: "known" as const, value });
const unknown = { status: "unknown" as const, reason: "not-described" };
const nativeField = (): NativeContractValueEvidence => ({
  nativeType: known({ name: "i64", complete: true }),
  runtimeType: known("bigint" as const),
  nullable: unknown,
  descriptor: { typeId: "i64" },
});
function native(evidencePatch: Partial<NativeQueryContractEvidence> = {}) {
  const evidence: NativeQueryContractEvidence = {
    adapter: { id: "vendor/native", version: "1" },
    consistency: { mechanism: "snapshot", scope: "qualified-fixture" },
    resultKind: "rows",
    columns: [{ ...nativeField(), name: "score" }],
    parameters: [{ ...nativeField(), index: 1 }],
    parameterOccurrences: [{ index: 1, start: sql.indexOf("$1"), end: sql.indexOf("$1") + 2 }],
    ...evidencePatch,
  };
  const descriptor = (value: NativeContractValueEvidence) => ({
    type: value.runtimeType.status === "known" ? value.runtimeType.value : ("unknown" as const),
    nullable: value.nullable.status === "known" ? value.nullable.value : true,
    ...(value.nativeType.status === "known" ? { databaseType: value.nativeType.value.name } : {}),
  });
  return createQueryContract({
    sql,
    context,
    origin: "native-description",
    nativeEvidence: evidence,
    valuePlan: {
      dialect: schema.dialect,
      typePolicyHash: context.typePolicyHash,
      columns: evidence.columns.map((value) => ({ ...descriptor(value), name: value.name })),
      parameters: evidence.parameters.map((value) => ({ ...descriptor(value), index: value.index })),
    },
  });
}
function analysis(patch: Partial<DialectAnalysis> = {}): DialectAnalysis {
  return {
    columns: [{ name: "score", tsType: "bigint", runtimeType: "bigint", databaseType: "i64", nullable: true, range }],
    parameters: [{ index: 1, tsType: "bigint", runtimeType: "bigint", databaseType: "i64", nullable: true }],
    diagnostics: [],
    resultKind: "rows",
    semantics: unknownQuerySemantics(range, "fixture"),
    ...patch,
  };
}
const owner: ContractReconciliationContribution = {
  id: "vendor/reconciliation",
  version: "1",
  grammar: context.grammar,
  classify: (claim) =>
    claim.diagnostics.some((item) => item.severity === "error")
      ? {
          status: "invalid",
          rule: "invalid-remains-blocking",
          reason: "Native acceptance contradicts an invalidity claim",
        }
      : { status: "resolved", rule: "static-accepted", reason: "Independent successful static inference" },
  compare({ facet, expected, native }) {
    const decision = (
      status: "compatible" | "conflict" | "widened" | "unavailable",
      staticStatus: "known" | "partial" | "unknown",
    ) => ({ status, staticStatus, rule: `fixture-${facet}`, reason: "Compare independent fixture evidence" });
    if (facet === "nullability")
      return native.nullable.status === "unknown"
        ? decision("widened", "known")
        : decision(
            native.nullable.value && !expected.nullable
              ? native.nullable.precision === "exact"
                ? "conflict"
                : "widened"
              : "compatible",
            "known",
          );
    if (facet === "runtime-type")
      return expected.runtimeType === undefined || expected.runtimeType === "unknown"
        ? decision("unavailable", "unknown")
        : native.runtimeType.status === "unknown"
          ? decision("widened", "known")
          : decision(
              canonicalContractData(expected.runtimeType) === canonicalContractData(native.runtimeType.value)
                ? "compatible"
                : "conflict",
              "known",
            );
    return expected.databaseType === undefined
      ? decision("unavailable", "unknown")
      : native.nativeType.status === "unknown"
        ? decision("widened", "known")
        : decision(
            expected.databaseType === native.nativeType.value.name ? "compatible" : "conflict",
            expected.databaseTypeIsPartial ? "partial" : "known",
          );
  },
};
const qualification: ContractQualificationPolicy = {
  mode: "native-required",
  owner: { id: owner.id, version: owner.version },
  requiredNativeFacets: ["runtime-type"],
};
const claim = (value = analysis()) => createStaticQueryClaim({ sql, context, analysis: value });
const reconcile = (value = analysis(), contract = native(), selected = qualification, contribution = owner) =>
  reconcileQueryContract({ nativeContract: contract, staticClaim: claim(value), contribution, policy: selected });
const profile = {
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: schema.dialect,
  grammarVersion: "1",
  sqlModule: "vendor/graph",
  defaultTypePolicy: policy,
  capabilities: {},
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (value: string) => value,
  validateSnapshot: () => schema,
  parameterOccurrences: () => [{ index: 1, range: { ...range, start: sql.indexOf("$1"), end: sql.indexOf("$1") + 2 } }],
};
await describe("independent native/static reconciliation", async () => {
  await it("qualifies successful offline inference without turning unknown nullability into exact agreement", () => {
    const result = reconcile();
    strict.equal(result.status, "qualified");
    if (result.status !== "qualified") throw Error("missing qualified contract");
    strict.equal(result.contract.origin, "reconciled");
    strict.equal(result.contract.qualification!.sourceContractHash, native().digest);
    strict.equal(result.report.comparisons.length, 9);
    strict.ok(
      result.report.comparisons.some(
        (item) => item.facet === "nullability" && item.status === "widened" && item.nativeStatus === "unknown",
      ),
    );
    strict.deepEqual(parseQueryContract(JSON.parse(canonicalContractData(result.contract))), result.contract);
    const strictDialect = createContractDialect({
      profile,
      context,
      contracts: [result.contract],
      qualificationPolicyHash: result.report.policyHash,
    });
    strict.deepEqual(strictDialect.analyze(sql, schema).diagnostics, []);
    strict.equal(
      createContractDialect({
        profile,
        context,
        contracts: [native()],
        qualificationPolicyHash: result.report.policyHash,
      }).analyze(sql, schema).diagnostics[0]?.code,
      "TSQ406",
    );
    strict.equal(
      createContractDialect({
        profile,
        context,
        contracts: [result.contract],
        qualificationPolicyHash: queryContractDigest("different"),
      }).analyze(sql, schema).diagnostics[0]?.code,
      "TSQ406",
    );
    strict.throws(
      () => createContractDialect({ profile, context, contracts: [], qualificationPolicyHash: "invalid" }),
      /policy hash/u,
    );
    strict.ok(!canonicalContractData(result.contract.qualification).includes("tsType"));
  });
  await it("blocks apparently successful wrong mappings instead of replacing their claims silently", () => {
    const wrong = analysis({
      columns: [
        {
          name: "score",
          tsType: "string",
          runtimeType: "string",
          databaseType: "string_value",
          nullable: false,
          range,
        },
      ],
    });
    const result = reconcile(wrong);
    strict.equal(result.status, "conflict");
    strict.ok(!("contract" in result));
    strict.ok(result.report.comparisons.some((item) => item.facet === "runtime-type" && item.status === "conflict"));
    strict.equal(reconcile(analysis({ columns: [{ ...analysis().columns[0]!, name: "other" }] })).status, "conflict");
    strict.equal(reconcile(analysis({ parameters: [] })).status, "conflict");
    strict.equal(reconcile(analysis({ resultKind: "command" })).status, "conflict");
    strict.equal(
      reconcile(
        analysis({
          diagnostics: [{ code: "INVALID", severity: "error", message: "recognizable-private-source", range }],
        }),
      ).status,
      "conflict",
    );
    strict.ok(
      !canonicalContractData(
        claim(
          analysis({
            diagnostics: [{ code: "WARN", severity: "warning", message: "recognizable-private-source", range }],
          }),
        ),
      ).includes("recognizable-private-source"),
    );
  });
  await it("distinguishes native upper bounds from exact nullable evidence", () => {
    const nonnull = analysis({ columns: [{ ...analysis().columns[0]!, nullable: false }] });
    for (const precision of ["upper-bound", "exact"] as const) {
      const contract = native({
        columns: [{ ...nativeField(), name: "score", nullable: { ...known(true), precision } }],
      });
      strict.equal(reconcile(nonnull, contract).status, precision === "exact" ? "conflict" : "qualified");
      strict.equal(
        reconcile(nonnull, contract, { ...qualification, requiredNativeFacets: ["nullability"] }).status,
        precision === "exact" ? "conflict" : "incomplete",
      );
    }
    const exact = native({
      columns: [{ ...nativeField(), name: "score", nullable: { ...known(false), precision: "exact" } }],
      parameters: [{ ...nativeField(), index: 1, nullable: { ...known(false), precision: "upper-bound" } }],
    });
    strict.equal(
      reconcile(analysis(), exact, { ...qualification, requiredNativeFacets: ["nullability"] }).status,
      "qualified",
    );
  });
  await it("fills unknown static facets, rejects missing required native facts and keeps unsupported diagnostics scoped", () => {
    const unresolved = analysis({ columns: [{ name: "score", tsType: "unknown", nullable: true, range }] });
    strict.equal(reconcile(unresolved).status, "qualified");
    const opaque = native({
      columns: [{ ...nativeField(), name: "score", runtimeType: unknown, nativeType: unknown }],
    });
    strict.equal(reconcile(analysis(), opaque).status, "incomplete");
    strict.equal(
      reconcile(analysis(), opaque, { ...qualification, mode: "hybrid", requiredNativeFacets: [] }).status,
      "qualified",
    );
    strict.equal(
      reconcile(analysis(), native({ parameters: [{ ...nativeField(), index: 1, runtimeType: unknown }] })).status,
      "incomplete",
    );
    const partial = native({
      columns: [{ ...nativeField(), name: "score", nativeType: known({ name: "i64", complete: false }) }],
    });
    strict.equal(
      reconcile(analysis(), partial, { ...qualification, requiredNativeFacets: ["native-type"] }).status,
      "incomplete",
    );
    const unsupported = {
      ...owner,
      classify: () => ({
        status: "unsupported" as const,
        rule: "qualified-unsupported-production",
        reason: "This contributed owner classifies the specific unsupported production",
      }),
    };
    strict.equal(
      reconcile(
        analysis({ columns: [], parameters: [], resultKind: undefined } as never),
        native(),
        qualification,
        unsupported,
      ).status,
      "qualified",
    );
    const unverified = {
      ...owner,
      compare: () => ({
        status: "unavailable" as const,
        staticStatus: "known" as const,
        rule: "unverified-refinement",
        reason: "No independent comparison rule",
      }),
    };
    strict.equal(reconcile(analysis(), native(), qualification, unverified).status, "incomplete");
  });
  await it("validates claim identities, policy/owner selection and diagnostic decisions", () => {
    const value = claim();
    strict.deepEqual(parseStaticQueryClaim(value), value);
    strict.ok(Object.isFrozen(value.columns[0]));
    for (const patch of [
      { digest: "0".repeat(64) },
      { sqlDigest: "invalid" },
      { resultKind: "invalid" },
      { columns: false },
      { parameters: false },
      { diagnostics: [{ code: "", severity: "error" }] },
      { columns: [{ ...value.columns[0], extra: "ignored" }] },
    ])
      strict.throws(() => parseStaticQueryClaim({ ...value, ...patch }));
    strict.throws(() =>
      createStaticQueryClaim({
        sql,
        context,
        analysis: analysis({ columns: [{ ...analysis().columns[0]!, tsType: "" }] }),
      }),
    );
    const altered = createStaticQueryClaim({ sql: `${sql} `, context, analysis: analysis() });
    strict.throws(
      () =>
        reconcileQueryContract({
          nativeContract: native(),
          staticClaim: altered,
          contribution: owner,
          policy: qualification,
        }),
      /context differs/u,
    );
    strict.throws(
      () => reconcile(analysis(), native(), qualification, { ...owner, grammar: { id: "different", version: "1" } }),
      /owner grammar/u,
    );
    strict.throws(
      () => reconcile(analysis(), native(), { ...qualification, owner: { id: "other", version: "1" } }),
      /owner policy/u,
    );
    strict.throws(
      () =>
        reconcile(analysis(), native(), qualification, {
          ...owner,
          classify: () => ({ status: "wrong" as never, rule: "x", reason: "x" }),
        }),
      /classification/u,
    );
    strict.throws(
      () =>
        reconcile(
          analysis({ diagnostics: [{ code: "ERR", severity: "error", message: "error", range }] }),
          native(),
          qualification,
          { ...owner, classify: () => ({ status: "resolved", rule: "x", reason: "x" }) },
        ),
      /cannot be classified/u,
    );
    strict.throws(
      () =>
        reconcile(analysis(), native(), qualification, {
          ...owner,
          compare: () => ({ status: "invalid" as never, staticStatus: "known", rule: "x", reason: "x" }),
        }),
      /decision/u,
    );
    for (const bad of [
      null,
      { ...qualification, mode: "invalid" },
      { ...qualification, requiredNativeFacets: ["runtime-type", "runtime-type"] },
      { ...qualification, requiredNativeFacets: ["invented"] },
    ])
      strict.throws(() => parseContractQualificationPolicy(bad));
  });
  await it("rejects incomplete, altered or falsely strengthened qualification proofs", () => {
    const result = reconcile();
    if (result.status !== "qualified") throw Error("missing proof");
    strict.throws(() => reconcile(analysis(), result.contract), /fresh native/u);
    const evidence = result.contract.nativeEvidence!,
      proof = result.report;
    for (const patch of [
      { policyHash: "invalid" },
      { nativeEvidenceHash: queryContractDigest("different") },
      { comparisons: [] },
      { comparisons: [...proof.comparisons, proof.comparisons[0]] },
      { comparisons: proof.comparisons.map((item, index) => (index === 0 ? { ...item, status: "conflict" } : item)) },
      {
        comparisons: proof.comparisons.map((item) =>
          item.facet === "nullability" ? { ...item, nativeStatus: "complete" } : item,
        ),
      },
    ])
      strict.throws(() => parseQueryContractQualification({ ...proof, ...patch }, evidence));
    const { digest: _digest, ...body } = result.contract;
    for (const patch of [
      { origin: "native-description" },
      { qualification: { ...proof, sourceContractHash: queryContractDigest("wrong") } },
    ]) {
      const altered = { ...body, ...patch };
      strict.throws(() => parseQueryContract({ ...altered, digest: queryContractDigest(altered) }));
    }
  });
});
