import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { compileSource } from "../../compiler/src/index.js";
import {
  DIALECT_CONTRACT_VERSION,
  decodeQueryResultRows,
  defineQueryValuePlan,
  type QueryValuePlan,
  type RuntimeValueType,
  type SchemaSnapshot,
  sql,
  withQueryValuePlan,
} from "../../core/src/index.js";
import { calculateSchemaHash, calculateTypePolicyHash } from "../../schema/src/index.js";
import {
  canonicalContractData,
  createContractDialect,
  createQueryContract,
  createQueryContractIndex,
  exportQueryContracts,
  loadQueryContracts,
  parseQueryContract,
  parseQueryContractContext,
  type QueryContractContext,
  queryContractDigest,
  serializeQueryContract,
} from "../src/index.js";

const schema = { formatVersion: 1, dialect: "vendor/graph", tables: {}, functions: {} } as const;
const policy = { integer: "bigint" };
const context: QueryContractContext = {
  grammar: { id: "vendor/graph", version: "1" },
  profileHash: queryContractDigest("profile"),
  schemaHash: calculateSchemaHash(schema),
  databaseContextHash: queryContractDigest("database"),
  typePolicyHash: calculateTypePolicyHash(policy),
  codecHash: queryContractDigest("codecs"),
  interpreterHash: queryContractDigest("interpreter"),
};
const text = "SELECT extension_score($1) AS score";
const plan: QueryValuePlan = {
  dialect: schema.dialect,
  typePolicyHash: context.typePolicyHash,
  columns: [{ name: "score", type: "bigint", databaseType: "bigint", nullable: true }],
  parameters: [{ index: 1, type: "string", databaseType: "text", nullable: true }],
};
const contract = () =>
  createQueryContract({
    sql: text,
    context,
    valuePlan: plan,
    origin: "native-description",
    columnSpans: [{ start: 7, end: text.length }],
  });
const profile = {
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: schema.dialect,
  grammarVersion: "1",
  sqlModule: "@vendor/graph",
  runtimeSqlModule: "@vendor/graph/query",
  capabilities: {},
  defaultTypePolicy: policy,
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (name: string) => `"${name.replaceAll('"', '""')}"`,
  validateSnapshot: (): SchemaSnapshot => schema,
};

await describe("query contract identity and frozen consumption", async () => {
  await it("round trips canonical data and binds exact SQL/context without storing source or values", () => {
    const original = contract(),
      encoded = serializeQueryContract(original),
      parsed = parseQueryContract(JSON.parse(encoded));
    strict.deepEqual(parsed, original);
    strict.ok(Object.isFrozen(parsed.valuePlan.columns));
    strict.ok(!encoded.includes(text));
    const index = createQueryContractIndex([original, parsed]);
    strict.equal(index.size, 1);
    strict.equal(index.resolve(context, text)?.digest, original.digest);
    strict.equal(index.resolve(context, `${text} `), undefined);
    for (const field of [
      "profileHash",
      "schemaHash",
      "databaseContextHash",
      "typePolicyHash",
      "codecHash",
      "interpreterHash",
    ] as const)
      strict.equal(index.resolve({ ...context, [field]: queryContractDigest(field) }, text), undefined, field);
    strict.equal(queryContractDigest({ b: 2, a: 1 }), queryContractDigest({ a: 1, b: 2 }));
  });
  await it("compiles an otherwise unknown query and runtime value plan without a SQL analyzer", () => {
    const dialect = createContractDialect({ profile, context, contracts: [contract()] });
    const result = compileSource({
      source: 'import {sql} from "@vendor/graph"; const query=sql`SELECT extension_score(${input}) AS score`;',
      dialect,
      schema,
      runtimeMetadata: true,
    });
    strict.deepEqual(result.diagnostics, []);
    strict.equal(result.queries.length, 1);
    strict.match(result.queries[0]!.rowType, /score.*bigint.*null/u);
    strict.match(result.queries[0]!.parameterType, /string.*null/u);
    strict.deepEqual(result.queries[0]!.valuePlan, defineQueryValuePlan(plan));
    const q = withQueryValuePlan(sql`SELECT extension_score(${"input"}) AS score`, result.queries[0]!.valuePlan!);
    strict.deepEqual(
      decodeQueryResultRows(q, [{ score: 4n }, { score: null }], {
        id: "native-test",
        dialect: schema.dialect,
        typePolicyHash: context.typePolicyHash,
        integer: "lossless",
        jsonWire: "text",
      }),
      [{ score: 4n }, { score: null }],
    );
  });
  await it("fails closed for missing, mismatched and repeated query evidence", () => {
    const dialect = createContractDialect({ profile, context, contracts: [contract()] });
    for (const [query, version, selectedPolicy, analysis] of [
      [`${text} `, schema, policy, undefined],
      [text, { ...schema, tables: { changed: { name: "changed", columns: {} } } }, policy, undefined],
      [text, schema, { integer: "number" }, undefined],
      [text, schema, policy, { repeatedFragmentRanges: [{ start: 7, end: 20 }] }],
    ] as const) {
      const result = dialect.analyze(query, version, selectedPolicy, analysis);
      strict.deepEqual(result.columns, []);
      strict.equal(result.diagnostics[0]?.code, "TSQ406");
      strict.equal(result.semantics.operation.value, "unknown");
    }
    strict.throws(
      () =>
        createContractDialect({
          profile: {
            ...profile,
            analyze() {
              throw Error("must not run");
            },
          },
          context,
          contracts: [],
        } as never),
      /eager analyzer/u,
    );
    strict.throws(
      () => createContractDialect({ profile: { ...profile, grammarVersion: "2" }, context, contracts: [] }),
      /identity/u,
    );
  });
  await it("rejects conflicting contracts, malformed descriptors and modified content", () => {
    const first = contract(),
      other = createQueryContract({
        sql: text,
        context,
        valuePlan: { ...plan, columns: [{ name: "score", type: "number", nullable: true }] },
        origin: "native-description",
      });
    strict.throws(() => createQueryContractIndex([first, other]), /Conflicting/u);
    for (const patch of [
      { formatVersion: 2 },
      { digest: "x" },
      { sqlDigest: "x" },
      { sqlLength: 0 },
      { origin: "sample" },
      { extra: "data" },
      { columnSpans: [] },
      { columnSpans: [{ start: -1, end: 0 }] },
      { valuePlan: { ...plan, dialect: "other" } },
      { valuePlan: { ...plan, columns: [{ name: "score", type: "any", nullable: false }] } },
    ])
      strict.throws(() => parseQueryContract({ ...first, ...patch }));
    strict.throws(() => parseQueryContract({ ...first, origin: "offline-rule" }), /digest differs/u);
    strict.throws(() => parseQueryContractContext({ ...context, profileHash: "x" }), /profileHash/u);
    strict.throws(() => parseQueryContractContext({ ...context, grammar: { id: "", version: "1" } }), /grammar/u);
    strict.throws(() => createQueryContract({ sql: "", context, valuePlan: plan, origin: "offline-rule" }), /length/u);
  });
  await it("rejects executable, cyclic and unbounded artifacts without calling getters", () => {
    let called = false;
    const getter = {
      get value() {
        called = true;
        return "value";
      },
    };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      getter,
      cycle,
      new Date(),
      undefined,
      () => 1,
      NaN,
      { value: Symbol("x") },
      new Array(2),
      { [Symbol("x")]: 1 },
    ])
      strict.throws(() => canonicalContractData(value));
    strict.equal(called, false);
    let nested: unknown = null;
    for (let n = 0; n < 66; n++) nested = [nested];
    strict.throws(() => canonicalContractData(nested), /limits/u);
  });
  await it("derives complex application types from the same validated descriptors used for decoding", () => {
    const cases: readonly [RuntimeValueType, string][] = [
      ["number", "number"],
      ["boolean", "boolean"],
      ["date", "Date"],
      ["bytes", "Uint8Array"],
      ["unknown", "unknown"],
      ["never", "never"],
      [{ literal: 'quoted"value' }, JSON.stringify('quoted"value')],
      [{ array: "number" }, "readonly (number | null)[]"],
      [{ array: "number", elementNullable: false }, "readonly (number)[]"],
      [{ tuple: [{ type: "string", nullable: true }] }, "readonly [string | null]"],
      [{ union: ["string", "number"] }, "(string) | (number)"],
      [{ object: { nested: { type: "number", nullable: true } } }, '{ "nested": number | null; }'],
      [{ json: { shape: { kind: "string" }, representation: "parsed" } }, "string"],
      [{ json: { shape: { kind: "unknown" }, representation: "text" } }, "string"],
      [{ json: { shape: { kind: "unknown" }, representation: "binary" } }, "Uint8Array"],
    ];
    for (const [type, expected] of cases) {
      const c = createQueryContract({
        sql: text,
        context,
        origin: "offline-rule",
        valuePlan: { ...plan, columns: [{ name: "score", type, nullable: true }] },
      });
      const result = createContractDialect({ profile, context, contracts: [c] }).analyze(text, schema);
      strict.equal(result.columns[0]?.tsType, expected);
      strict.deepEqual(result.columns[0]?.runtimeType, c.valuePlan.columns[0]!.type);
    }
  });
});

await describe("durable contract closure", async () => {
  await it("exports deterministically, survives cache deletion and consumes only its declared inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "typed-sql-contracts-"));
    try {
      const directory = join(root, "durable");
      const first = contract();
      const second = createQueryContract({ sql: `${text} `, context, origin: "offline-rule", valuePlan: plan });
      const digest = await exportQueryContracts(directory, [second, first, first]);
      strict.equal(await exportQueryContracts(directory, [first, second]), digest);
      await writeFile(join(directory, "queries", "unrelated.json"), "broken");
      await rm(join(root, ".typed-sql"), { recursive: true, force: true });
      const loaded = await loadQueryContracts(directory);
      strict.equal(loaded.length, 2);
      strict.ok(Object.isFrozen(loaded));
      strict.equal(
        createContractDialect({ profile, context, contracts: loaded }).analyze(text, schema).diagnostics.length,
        0,
      );
      // A new explicit export replaces the whole declared closure; old objects are not inferred as inputs.
      await exportQueryContracts(directory, [second]);
      strict.equal((await loadQueryContracts(directory)).length, 1);
      strict.equal(createQueryContractIndex(await loadQueryContracts(directory)).resolve(context, text), undefined);
      strict.ok((await readdir(join(directory, "queries"))).every((name) => !name.endsWith(".tmp")));
      await exportQueryContracts(directory, []);
      strict.deepEqual(await loadQueryContracts(directory), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await it("publishes complete generations under concurrent export and refuses immutable object corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-contracts-"));
    try {
      const first = contract();
      const second = createQueryContract({ sql: `${text} `, context, origin: "offline-rule", valuePlan: plan });
      await Promise.all([exportQueryContracts(directory, [first]), exportQueryContracts(directory, [second])]);
      strict.equal((await loadQueryContracts(directory)).length, 1);
      const before = await readFile(join(directory, "manifest.json"), "utf8");
      await writeFile(join(directory, "queries", `${first.digest}.json`), "corrupt");
      await strict.rejects(exportQueryContracts(directory, [first]), /Conflicting immutable/u);
      strict.equal(await readFile(join(directory, "manifest.json"), "utf8"), before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("rejects missing, oversized, corrupt, swapped and incomplete declared artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-contracts-"));
    try {
      const first = contract();
      await exportQueryContracts(directory, [first]);
      const manifestPath = join(directory, "manifest.json");
      const original = JSON.parse(await readFile(manifestPath, "utf8"));
      const mutateManifest = async (value: Record<string, unknown>) => {
        const { digest: _digest, ...body } = value;
        await writeFile(manifestPath, JSON.stringify({ ...body, digest: queryContractDigest(body) }));
      };
      for (const value of [
        null,
        {},
        { ...original, formatVersion: 2 },
        { ...original, queries: ["../escape"] },
        { ...original, queries: [first.digest, first.digest] },
        { ...original, digest: "0".repeat(64) },
      ]) {
        await writeFile(manifestPath, JSON.stringify(value));
        await strict.rejects(loadQueryContracts(directory), /manifest|references/u);
      }
      await writeFile(manifestPath, " ".repeat(8 * 1024 * 1024 + 1));
      await strict.rejects(loadQueryContracts(directory), /byte limit/u);
      await mutateManifest({ ...original, contexts: [] });
      await strict.rejects(loadQueryContracts(directory), /outside the declared closure/u);
      await mutateManifest({ ...original, queries: [] });
      await strict.rejects(loadQueryContracts(directory), /Unused/u);
      await writeFile(manifestPath, JSON.stringify(original));
      const contextPath = join(directory, "contexts", `${queryContractDigest(context)}.json`);
      await writeFile(contextPath, JSON.stringify({ ...context, codecHash: queryContractDigest("changed") }));
      await strict.rejects(loadQueryContracts(directory), /context digest/u);
      await writeFile(contextPath, JSON.stringify(context));
      const objectPath = join(directory, "queries", `${first.digest}.json`);
      const second = createQueryContract({ sql: `${text} `, context, origin: "offline-rule", valuePlan: plan });
      await writeFile(objectPath, serializeQueryContract(second));
      await strict.rejects(loadQueryContracts(directory), /object digest/u);
      await writeFile(objectPath, "{");
      await strict.rejects(loadQueryContracts(directory), SyntaxError);
      await rm(objectPath);
      await strict.rejects(loadQueryContracts(directory), { code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
