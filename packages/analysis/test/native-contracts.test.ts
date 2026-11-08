import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { DIALECT_CONTRACT_VERSION, type SchemaSnapshot } from "../../core/src/index.js";
import { calculateSchemaHash, calculateTypePolicyHash } from "../../schema/src/index.js";
import {
  acquireNativeQueryContract,
  canonicalContractData,
  createContractDialect,
  createQueryContract,
  exportQueryContracts,
  loadQueryContracts,
  type NativeContractAdapter,
  type NativeContractCandidate,
  type NativeQueryContractEvidence,
  parseNativeQueryContractEvidence,
  parseQueryContract,
  type QueryContractContext,
  queryContractDigest,
  serializeQueryContract,
} from "../src/index.js";

const known = <Value>(value: Value) => ({ status: "known" as const, value });
const unknown = { status: "unknown" as const, reason: "protocol-does-not-report-this-facet" };
const schema = { formatVersion: 1, dialect: "vendor/graph", tables: {} } as const;
const policy = { integer: "bigint" };
const context: QueryContractContext = {
  grammar: { id: schema.dialect, version: "1" },
  profileHash: queryContractDigest("profile"),
  schemaHash: calculateSchemaHash(schema),
  databaseContextHash: queryContractDigest("context"),
  typePolicyHash: calculateTypePolicyHash(policy),
  codecHash: queryContractDigest("codecs"),
  interpreterHash: queryContractDigest("interpreter"),
};
const sql = "SELECT extension_score($1) AS score";
const occurrences = [{ index: 1, start: sql.indexOf("$1"), end: sql.indexOf("$1") + 2 }];
const candidate: NativeContractCandidate = { sql, parameterOccurrences: occurrences };
const field = () => ({
  nativeType: known({ name: "int8", complete: true }),
  runtimeType: known("bigint" as const),
  nullable: unknown,
  descriptor: { nativeCode: 20 },
});
const evidence = (): NativeQueryContractEvidence => ({
  adapter: { id: "vendor/graph/native", version: "1" },
  consistency: { mechanism: "snapshot", scope: "catalog-and-statement" },
  resultKind: "rows",
  columns: [{ ...field(), name: "score" }],
  parameters: [{ ...field(), index: 1 }],
  parameterOccurrences: occurrences,
});
const profile = {
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: schema.dialect,
  grammarVersion: "1",
  sqlModule: "@vendor/graph",
  defaultTypePolicy: policy,
  capabilities: {},
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (name: string) => JSON.stringify(name),
  validateSnapshot: (): SchemaSnapshot => schema,
  parameterOccurrences: () =>
    occurrences.map(({ index, start, end }) => ({ index, range: { start, end, line: 1, column: start + 1 } })),
};
function fixture(
  options: {
    contexts?: readonly QueryContractContext[];
    description?: NativeQueryContractEvidence;
    describe?: (candidate: NativeContractCandidate) => Promise<NativeQueryContractEvidence>;
    close?: () => Promise<void>;
    accept?: NativeContractAdapter["accept"];
  } = {},
) {
  const calls: string[] = [];
  let reads = 0;
  const adapter: NativeContractAdapter = {
    ...evidence().adapter,
    grammar: context.grammar,
    accept: options.accept ?? (() => ({ accepted: true })),
    async open() {
      calls.push("open");
      return {
        async context() {
          calls.push("context");
          return options.contexts?.[reads++] ?? context;
        },
        async describe(value) {
          calls.push("describe");
          strict.ok(Object.isFrozen(value));
          return options.describe ? options.describe(value) : (options.description ?? evidence());
        },
        async close() {
          calls.push("close");
          await options.close?.();
        },
      };
    },
  };
  return { adapter, calls };
}
await describe("native query contract acquisition", async () => {
  await it("acquires independently of analyzer claims and preserves unknown facets through durable reload", async () => {
    const { adapter, calls } = fixture();
    strict.deepEqual(calls, []);
    const result = await acquireNativeQueryContract({ adapter, candidate, context });
    strict.equal(result.status, "acquired");
    if (result.status !== "acquired") throw Error("missing contract");
    strict.deepEqual(calls, ["open", "context", "describe", "context", "close"]);
    strict.equal(result.contract.valuePlan.columns[0]?.nullable, true);
    strict.equal(result.contract.nativeEvidence?.columns[0]?.nullable.status, "unknown");
    strict.ok(Object.isFrozen(result.contract.nativeEvidence!.columns[0]!.descriptor));
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-native-contract-"));
    try {
      await exportQueryContracts(directory, [result.contract]);
      const contracts = await loadQueryContracts(directory);
      const resolved = createContractDialect({ profile, context, contracts }).analyze(sql, schema);
      strict.deepEqual(resolved.diagnostics, []);
      strict.equal(resolved.columns[0]?.tsType, "bigint");
      strict.equal(resolved.columns[0]?.nullable, true);
      strict.equal(resolved.resultKind, "rows");
      strict.equal(resolved.semantics.operation.value, "unknown");
      const { parameterOccurrences: _occurrences, ...withoutOccurrences } = profile;
      strict.equal(
        createContractDialect({ profile: withoutOccurrences, context, contracts }).analyze(sql, schema).diagnostics[0]
          ?.code,
        "TSQ406",
      );
      strict.equal(
        createContractDialect({ profile: { ...profile, parameterOccurrences: () => [] }, context, contracts }).analyze(
          sql,
          schema,
        ).diagnostics[0]?.code,
        "TSQ406",
      );
      strict.deepEqual(parseQueryContract(JSON.parse(serializeQueryContract(result.contract))), result.contract);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("retains partial native identities and unknown result types without certifying them", async () => {
    const partial: NativeQueryContractEvidence = {
      ...evidence(),
      consistency: { mechanism: "guarded", scope: "qualified-schema-guard" },
      columns: [
        {
          ...field(),
          nativeType: known({ name: "numeric", complete: false }),
          runtimeType: unknown,
          nullable: known(false),
          name: "score",
        },
      ],
      parameters: [{ ...field(), nativeType: known({ name: "numeric", complete: false }), index: 1 }],
    };
    const { adapter } = fixture({ description: partial });
    const result = await acquireNativeQueryContract({ adapter, candidate, context });
    if (result.status !== "acquired") throw Error("missing contract");
    const resolved = createContractDialect({ profile, context, contracts: [result.contract] }).analyze(sql, schema);
    strict.equal(resolved.columns[0]?.tsType, "unknown");
    strict.equal(resolved.columns[0]?.nullable, false);
    strict.equal(resolved.columns[0]?.databaseTypeIsPartial, true);
    strict.equal(resolved.parameters[0]?.databaseTypeIsPartial, true);
    const opaque = { ...partial, columns: [{ ...partial.columns[0]!, nativeType: unknown }] };
    const acquired = await acquireNativeQueryContract({
      adapter: fixture({ description: opaque }).adapter,
      candidate,
      context,
    });
    if (acquired.status !== "acquired") throw Error("missing contract");
    strict.equal(acquired.contract.valuePlan.columns[0]?.databaseType, undefined);
  });
  await it("rejects unsupported candidates before opening a driver and guards context before and after describe", async () => {
    const rejected = fixture({ accept: () => ({ accepted: false, reason: "unqualified-statement-class" }) });
    strict.deepEqual(await acquireNativeQueryContract({ ...rejected, candidate, context }), {
      status: "unavailable",
      reason: "unsupported-statement",
      detail: "unqualified-statement-class",
    });
    strict.deepEqual(rejected.calls, []);
    const changed = { ...context, databaseContextHash: queryContractDigest("changed") };
    const mismatch = fixture({ contexts: [changed] });
    strict.deepEqual(await acquireNativeQueryContract({ ...mismatch, candidate, context }), {
      status: "unavailable",
      reason: "context-mismatch",
    });
    strict.deepEqual(mismatch.calls, ["open", "context", "close"]);
    const drift = fixture({ contexts: [context, changed] });
    strict.deepEqual(await acquireNativeQueryContract({ ...drift, candidate, context }), {
      status: "unavailable",
      reason: "context-changed",
    });
    strict.equal(drift.calls.at(-1), "close");
    for (const patch of [
      { nativeType: unknown },
      { runtimeType: unknown },
      { runtimeType: known("unknown" as const) },
      { runtimeType: known("never" as const) },
    ]) {
      const { adapter } = fixture({ description: { ...evidence(), parameters: [{ ...field(), ...patch, index: 1 }] } });
      strict.deepEqual(await acquireNativeQueryContract({ adapter, candidate, context }), {
        status: "unavailable",
        reason: "parameter-metadata-unavailable",
      });
    }
  });
  await it("closes sessions on failure or cancellation and never publishes mutated caller input", async () => {
    const controller = new AbortController();
    controller.abort();
    const before = fixture();
    await strict.rejects(acquireNativeQueryContract({ ...before, candidate, context, signal: controller.signal }), {
      name: "AbortError",
    });
    strict.deepEqual(before.calls, []);
    const during = new AbortController();
    const cancelled = fixture({
      describe: async () => {
        during.abort();
        return evidence();
      },
    });
    await strict.rejects(acquireNativeQueryContract({ ...cancelled, candidate, context, signal: during.signal }), {
      name: "AbortError",
    });
    strict.equal(cancelled.calls.at(-1), "close");
    const failure = fixture({
      describe: async () => {
        throw Error("native-failure");
      },
    });
    await strict.rejects(acquireNativeQueryContract({ ...failure, candidate, context }), /native-failure/u);
    strict.equal(failure.calls.at(-1), "close");
    const closeFailure = fixture({
      close: async () => {
        throw Error("cleanup-failure");
      },
    });
    await strict.rejects(acquireNativeQueryContract({ ...closeFailure, candidate, context }), /cleanup-failure/u);
    const mutable = { sql, parameterOccurrences: occurrences.map((item) => ({ ...item })) };
    const unchanged = fixture({
      describe: async (value) => {
        strict.equal(value.sql, sql);
        strict.equal(value.parameterOccurrences[0]!.index, 1);
        return evidence();
      },
    });
    const pending = acquireNativeQueryContract({ ...unchanged, candidate: mutable, context });
    mutable.sql = "changed";
    mutable.parameterOccurrences[0]!.index = 2;
    strict.equal((await pending).status, "acquired");
  });
  await it("rejects forged adapter/layout evidence and malformed requests without application values", async () => {
    const valid = fixture();
    await strict.rejects(
      acquireNativeQueryContract({
        adapter: { ...valid.adapter, grammar: { ...context.grammar, version: "2" } },
        candidate,
        context,
      }),
      /grammar mismatch/u,
    );
    for (const malformed of [
      null,
      [],
      { ...candidate, sql: "" },
      { ...candidate, values: [42] },
      { ...candidate, parameterOccurrences: [{ index: 2, start: 1, end: 2 }] },
      { ...candidate, columnSpans: false },
      { ...candidate, columnSpans: [{ start: -1, end: 2 }] },
    ])
      await strict.rejects(acquireNativeQueryContract({ ...valid, candidate: malformed as never, context }), TypeError);
    strict.deepEqual(valid.calls, []);
    const forged = fixture({ description: { ...evidence(), adapter: { id: "different", version: "1" } } });
    await strict.rejects(acquireNativeQueryContract({ ...forged, candidate, context }), /adapter mismatch/u);
    const wrongLayout = fixture({
      description: { ...evidence(), parameterOccurrences: [{ index: 1, start: 0, end: 1 }] },
    });
    await strict.rejects(acquireNativeQueryContract({ ...wrongLayout, candidate, context }), /layout differs/u);
    const withSpans = { ...candidate, columnSpans: [{ start: 7, end: sql.length }] };
    strict.equal(
      (await acquireNativeQueryContract({ ...fixture(), candidate: withSpans, context })).status,
      "acquired",
    );
  });
  await it("validates descriptor facets, layouts, labels and consistency declarations as bounded data", () => {
    const original = evidence();
    const patches: unknown[] = [
      null,
      { ...original, extra: 1 },
      { ...original, adapter: { id: "", version: "1" } },
      { ...original, consistency: { mechanism: "none", scope: "none" } },
      { ...original, resultKind: "command" },
      { ...original, columns: false },
      { ...original, columns: [original.columns[0], original.columns[0]] },
      { ...original, parameters: [{ ...original.parameters[0], index: 2 }] },
      { ...original, parameterOccurrences: false },
      { ...original, parameterOccurrences: [] },
      { ...original, parameterOccurrences: [{ index: 1, start: -1, end: 2 }] },
      { ...original, parameterOccurrences: [{ index: 1, start: 2, end: 2 }] },
      { ...original, parameterOccurrences: [{ index: 1, start: 0, end: sql.length + 1 }] },
    ];
    for (const patch of [
      { descriptor: null },
      { nativeType: known({ name: "int8", complete: 1 }) },
      { runtimeType: known("any") },
      { runtimeType: known({ array: "string", extra: true }) },
      { nullable: known("yes") },
      { nullable: { status: "maybe" } },
      { nullable: { status: "unknown", reason: "" } },
      { name: 3 },
    ])
      patches.push({ ...original, columns: [{ ...original.columns[0], ...patch }] });
    for (const patch of patches) strict.throws(() => parseNativeQueryContractEvidence(patch, sql.length), TypeError);
    strict.throws(() => parseNativeQueryContractEvidence(original, 0), /SQL length/u);
    const repeated = { ...original, parameterOccurrences: [{ index: 1, start: 0, end: 1 }, ...occurrences] };
    strict.equal(parseNativeQueryContractEvidence(repeated, sql.length).parameterOccurrences.length, 2);
    const command = {
      ...original,
      resultKind: "command" as const,
      columns: [],
      parameters: [],
      parameterOccurrences: [],
    };
    strict.equal(parseNativeQueryContractEvidence(command, 1).resultKind, "command");
  });
  await it("rejects evidence/value-plan disagreement even when content digests are recomputed", async () => {
    const result = await acquireNativeQueryContract({ ...fixture(), candidate, context });
    if (result.status !== "acquired") throw Error("missing contract");
    for (const patch of [
      { origin: "offline-rule" },
      {
        valuePlan: {
          ...result.contract.valuePlan,
          columns: [{ name: "score", type: "number", databaseType: "int8", nullable: true }],
        },
      },
    ]) {
      const { digest: _digest, ...body } = { ...result.contract, ...patch };
      strict.throws(() => parseQueryContract({ ...body, digest: queryContractDigest(body) }), /evidence differs/u);
    }
    strict.throws(
      () =>
        createQueryContract({
          sql,
          context,
          origin: "native-description",
          nativeEvidence: evidence(),
          valuePlan: { ...result.contract.valuePlan, parameters: [] },
        }),
      /evidence differs/u,
    );
    const unresolved = createQueryContract({
      sql,
      context,
      origin: "native-description",
      nativeEvidence: { ...evidence(), parameters: [{ ...field(), runtimeType: unknown, index: 1 }] },
      valuePlan: {
        ...result.contract.valuePlan,
        parameters: [{ index: 1, databaseType: "int8", type: "unknown", nullable: true }],
      },
    });
    strict.equal(
      createContractDialect({ profile, context, contracts: [unresolved] }).analyze(sql, schema).diagnostics[0]?.code,
      "TSQ406",
    );
    strict.ok(canonicalContractData(result.contract).includes("protocol-does-not-report-this-facet"));
  });
});
