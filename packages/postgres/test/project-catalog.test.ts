import {
  acquireNativeQueryContract,
  applyProjectCatalogs,
  createContractDialect,
  createProjectCatalog,
  createStaticQueryClaim,
  type NativeContractAdapter,
  type NativeContractValueEvidence,
  parseProjectCatalog,
  parseQueryContract,
  queryContractDigest,
  reconcileQueryContract,
  serializeQueryContract,
} from "@typed-sql/analysis";
import {
  calculateSchemaHash,
  calculateTypePolicyHash,
  parseSchemaSnapshot,
  type RoutineSnapshot,
  upgradeSchemaSnapshotV1,
} from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import {
  buildQueryManifest,
  collectQueryVerificationCandidates,
  compileSource,
  parseQueryManifest,
  serializeQueryManifest,
  verifyQueryManifest,
} from "../../compiler/src/index.js";
import { postgres as postgresCore } from "../src/analysis/core/18.js";
import { postgres, postgresServerEvidence } from "../src/analysis.js";
import { postgresProfile } from "../src/profile.js";
import { createPostgresProjectCatalog, createPostgresProjectCatalogContribution } from "../src/project-catalog.js";
import { createPostgresContractReconciler } from "../src/reconciliation.js";
import { defaultPostgresTypePolicy } from "../src/type-policy.js";
import { POSTGRES_DIALECT_VERSION } from "../src/version.js";

const base = upgradeSchemaSnapshotV1({
  formatVersion: 1,
  dialect: "postgres",
  dialectVersion: POSTGRES_DIALECT_VERSION,
  version: "18.6",
  server: postgresServerEvidence("18.6"),
  tables: {},
});
const hash = queryContractDigest("catalog-fixture");
const context = {
  grammar: { id: "postgres", version: POSTGRES_DIALECT_VERSION },
  profileHash: hash,
  codecHash: hash,
  interpreterHash: hash,
  schemaHash: calculateSchemaHash(base),
  typePolicyHash: calculateTypePolicyHash(defaultPostgresTypePolicy),
  databaseContextHash: hash,
};
const routine = (name: string, result = "bigint", changes: Partial<RoutineSnapshot> = {}): RoutineSnapshot => ({
  schema: "project",
  name,
  identity: `project.${name}(bigint)`,
  kind: "function",
  arguments: [
    {
      name: "value",
      mode: "in",
      typeIdentity: "pg_catalog.int8",
      databaseType: "bigint",
      tsType: "any",
      default: "none",
    },
  ],
  result: {
    kind: "scalar",
    typeIdentity: `pg_catalog.${result === "bigint" ? "int8" : result}`,
    databaseType: result,
    tsType: "any",
    nullable: false,
  },
  volatility: "immutable",
  deterministic: true,
  dataAccess: "none",
  nullInput: "strict",
  ...changes,
});
const routines = {
  "project.lookup": [routine("lookup")],
  "project.dynamic": [routine("dynamic", "anyelement", { polymorphicFamily: "anyelement" })],
  "project.lower": [routine("lower", "anyelement", { polymorphicFamily: "anyelement" })],
  "project.rounded": [routine("rounded", "numeric")],
  "project.optional": [
    routine("optional", "bigint", {
      arguments: [
        {
          name: "value",
          mode: "in",
          typeIdentity: "pg_catalog.int8",
          databaseType: "bigint",
          tsType: "any",
          default: "present",
        },
      ],
    }),
  ],
  "project.unused": [routine("unused")],
};
const source = parseSchemaSnapshot({ ...base, routines });
if (source.formatVersion !== 2) throw Error("Expected v2 fixture");
const make = (
  sql = [
    "SELECT project.lookup(1::bigint)",
    "SELECT project.dynamic(1)",
    "SELECT project.rounded(1)",
    "SELECT project.optional()",
    "SELECT project.lower(1)",
  ],
) => createPostgresProjectCatalog({ source, context, sql });
const apply = (catalog = make()) =>
  applyProjectCatalogs({
    schema: base as typeof base & { dialect: "postgres" },
    context,
    typePolicy: defaultPostgresTypePolicy,
    catalogs: [parseProjectCatalog(JSON.parse(JSON.stringify(catalog)))],
    contributions: [createPostgresProjectCatalogContribution()],
  });
await describe("PostgreSQL selected reusable declarations", async () => {
  await it("selects metadata from query calls and reuses fixed results for new invocations without a database", () => {
    const catalog = make();
    strict.equal(catalog.entries.length, 5);
    strict.ok(!JSON.stringify(catalog).includes("project.unused"));
    strict.equal(catalog.entries.find((entry) => entry.identity.includes("lookup"))?.permission, "fixed-result");
    const loaded = apply(catalog);
    const text =
      'import {sql} from "@typed-sql/postgres"; export const query=sql`SELECT project.lookup(${1n}) AS value`;';
    const before = compileSource({
      source: text,
      schema: { ...base, dialect: "postgres" as const },
      dialect: postgres(),
      runtimeMetadata: true,
    });
    strict.match(before.queries[0]!.rowType, /unknown/u);
    const compiled = compileSource({ source: text, schema: loaded.schema, dialect: postgres(), runtimeMetadata: true });
    strict.deepEqual(
      compiled.diagnostics.filter((item) => item.severity === "error"),
      [],
    );
    strict.equal(compiled.queries[0]!.rowType, '{ "value": bigint | null; }');
    strict.equal(compiled.queries[0]!.parameterType, "readonly [bigint | null]");
    strict.equal(compiled.queries[0]!.valuePlan?.columns[0]?.type, "bigint");
    strict.equal(compiled.queries[0]!.valuePlan?.columns[0]?.nullable, true);
    strict.equal(compiled.queries[0]!.valuePlan?.parameters[0]?.type, "bigint");
    strict.notEqual(loaded.context.profileHash, context.profileHash);
    strict.notEqual(loaded.context.schemaHash, context.schemaHash);
    const next = postgres().analyze("SELECT project.lookup(41::bigint) AS next_value", loaded.schema);
    strict.equal(next.columns[0]?.tsType, "bigint");
    strict.equal(next.columns[0]?.nullable, true);
    strict.deepEqual(next.columns[0]?.range, { start: 7, end: 47, line: 1, column: 8 });
  });
  await it("preserves partial evidence through project routines, derived queries, contracts, manifests and verification", async () => {
    const inner = "SELECT project.lookup($1::bigint) AS id, CAST($2 AS numeric) AS amount";
    const queries = [
      `SELECT nested.id, nested.amount FROM (${inner}) AS nested`,
      `WITH nested AS (${inner}) SELECT id, amount FROM nested`,
      `${inner} UNION ALL SELECT NULL::bigint AS id, NULL::numeric AS amount`,
    ];
    const catalog = make(queries);
    strict.equal(catalog.entries.length, 1);
    strict.equal(catalog.entries[0]!.permission, "fixed-result");
    const loaded = apply(catalog),
      core = postgresCore(),
      profile = postgresProfile();
    const contribution = createPostgresContractReconciler({ schema: loaded.schema });
    const policy = {
      mode: "native-required" as const,
      owner: { id: contribution.id, version: contribution.version },
      requiredNativeFacets: ["runtime-type" as const],
    };
    const field = (name: string, type: "bigint" | "string", complete: boolean): NativeContractValueEvidence => ({
      nativeType: { status: "known", value: { name, complete } },
      runtimeType: { status: "known", value: type },
      nullable: { status: "unknown", reason: "fixture-protocol-does-not-report-nullability" },
      descriptor: {},
    });
    for (const [index, text] of queries.entries()) {
      strict.ok(core.analyze(text, { ...base, dialect: "postgres" }).diagnostics.some(({ code }) => code === "TSQ408"));
      const staticAnalysis = core.analyze(text, loaded.schema);
      strict.deepEqual(staticAnalysis.diagnostics, []);
      strict.deepEqual(
        staticAnalysis.columns.map(({ tsType }) => tsType),
        ["bigint", "string"],
      );
      strict.equal(staticAnalysis.columns[0]!.nullable, true);
      strict.deepEqual(
        staticAnalysis.parameters.map(({ index, tsType }) => [index, tsType]),
        [
          [1, "bigint"],
          [2, "string"],
        ],
      );
      const occurrences = profile.parameterOccurrences!(text, loaded.schema).map(({ index, range }) => ({
        index,
        start: range.start,
        end: range.end,
      }));
      let opened = 0,
        described = 0,
        contexts = 0,
        closed = 0;
      // Independent protocol fixture: this does not expand the production PostgreSQL adapter's statement scope.
      const adapter: NativeContractAdapter = {
        id: "test/partial-protocol",
        version: "1",
        grammar: loaded.context.grammar,
        accept: (candidate) =>
          candidate.sql === text ? { accepted: true } : { accepted: false, reason: "fixture-exact-query-only" },
        async open() {
          opened++;
          return {
            async context() {
              contexts++;
              return loaded.context;
            },
            async describe() {
              described++;
              return {
                adapter: { id: adapter.id, version: adapter.version },
                consistency: { mechanism: "snapshot", scope: "independent-test-protocol" },
                resultKind: "rows",
                columns: [
                  { name: "id", ...field("bigint", "bigint", true) },
                  { name: "amount", ...field("numeric", "string", false) },
                ],
                parameters: [
                  { index: 1, ...field("bigint", "bigint", true) },
                  { index: 2, ...field("numeric", "string", false) },
                ],
                parameterOccurrences: occurrences,
              };
            },
            async close() {
              closed++;
            },
          };
        },
      };
      const acquired = await acquireNativeQueryContract({
        adapter,
        candidate: { sql: text, parameterOccurrences: occurrences },
        context: loaded.context,
      });
      strict.deepEqual([opened, contexts, described, closed], [1, 2, 1, 1]);
      if (acquired.status !== "acquired") throw Error("Expected independent protocol evidence");
      const reconciled = reconcileQueryContract({
        nativeContract: acquired.contract,
        staticClaim: createStaticQueryClaim({ sql: text, context: loaded.context, analysis: staticAnalysis }),
        contribution,
        policy,
      });
      strict.equal(reconciled.status, "qualified");
      if (reconciled.status !== "qualified")
        throw Error("Expected runtime qualification with explicitly partial native facets");
      strict.equal(
        reconcileQueryContract({
          nativeContract: acquired.contract,
          staticClaim: createStaticQueryClaim({ sql: text, context: loaded.context, analysis: staticAnalysis }),
          contribution,
          policy: { ...policy, requiredNativeFacets: ["native-type"] },
        }).status,
        "incomplete",
        "Partial numeric identity cannot satisfy an exact native-type requirement",
      );
      const contract = parseQueryContract(JSON.parse(serializeQueryContract(reconciled.contract)));
      strict.equal(contract.nativeEvidence!.columns[1]!.nativeType.status, "known");
      strict.equal(contract.nativeEvidence!.columns[1]!.nullable.status, "unknown");
      const frozen = createContractDialect({
        profile,
        context: loaded.context,
        contracts: [contract],
        qualificationPolicyHash: queryContractDigest(policy),
      });
      const preserved = frozen.analyze(text, loaded.schema);
      strict.equal(preserved.columns[1]!.databaseTypeIsPartial, true);
      strict.equal(preserved.parameters[1]!.databaseTypeIsPartial, true);
      strict.ok(preserved.columns.every(({ nullable }) => nullable));
      strict.equal(preserved.semantics.operation.value, "unknown");
      const rootDir = "/partial-composition";
      const querySource =
        'import {sql} from "@typed-sql/postgres"; export const query=sql`' +
        text.replace("$1", "${id}").replace("$2", "${amount}") +
        "`;";
      const options = {
        rootDir,
        sources: [{ file: `${rootDir}/query-${index}.ts`, source: querySource }],
        dialect: frozen,
        schema: loaded.schema,
        compilerVersion: "composition-test",
      };
      const manifest = parseQueryManifest(JSON.parse(serializeQueryManifest(buildQueryManifest(options).manifest)));
      const entry = manifest.queries[0]!;
      if (entry.status !== "resolved") throw Error("Expected preserved contract in manifest");
      strict.equal(entry.variants[0]!.columns[1]!.databaseTypeIsPartial, true);
      strict.equal(entry.variants[0]!.parameters[1]!.databaseTypeIsPartial, true);
      const candidates = collectQueryVerificationCandidates({ ...options, manifest });
      strict.equal(candidates.length, 1);
      const candidate = candidates[0]!;
      strict.equal(candidate.columns[1]!.databaseTypeIsPartial, true);
      strict.equal(candidate.parameters[1]!.databaseTypeIsPartial, true);
      let verifications = 0;
      const verifier = (mismatch: boolean) => ({
        dialect: "postgres",
        adapterVersion: "independent-partial-verification-fixture",
        async server() {
          return { version: "18.6" };
        },
        compareDatabaseTypes(expected: string, actual: string) {
          strict.equal(expected, "bigint", "Partial numeric identities must bypass exact comparison");
          strict.equal(actual, "bigint");
          return "equal" as const;
        },
        async verify() {
          verifications++;
          return {
            columns: [
              { index: 1, name: "id", databaseType: "bigint", tsType: mismatch ? "string" : "bigint" },
              { index: 2, name: "amount", databaseType: "numeric(12,3)", tsType: "string" },
            ],
            parameters: [
              { index: 1, databaseType: "bigint", tsType: "bigint" },
              { index: 2, databaseType: "numeric(12,3)", tsType: "string" },
            ],
          };
        },
        async close() {},
      });
      const blocked = await verifyQueryManifest({ manifest, candidates, verifier: verifier(false) });
      strict.equal(blocked.proof.entries[0]!.status, "skipped");
      strict.equal(verifications, 0, "A frozen description alone cannot establish execution effects");
      // Supply the separately computed core operation solely for the explicit verification pass.
      strict.equal(staticAnalysis.semantics.operation.value, "read");
      const independentlyClassified = [{ ...candidate, operation: staticAnalysis.semantics.operation.value }];
      for (const mismatch of [false, true]) {
        const checked = await verifyQueryManifest({
          manifest,
          candidates: independentlyClassified,
          verifier: verifier(mismatch),
        });
        const result = checked.proof.entries[0]!;
        strict.equal(result.status, mismatch ? "mismatch" : "skipped");
        if (result.status === "skipped") strict.equal(result.reason, "native-metadata-unavailable");
        if (result.status === "mismatch") strict.ok(result.mismatches.some(({ kind }) => kind === "typescript-type"));
      }
      strict.equal(verifications, 2);
    }
  });
  await it("preserves polymorphism/default metadata but requires exact contracts instead of optimistic rules", () => {
    const catalog = make();
    strict.equal(
      (catalog.entries.find((entry) => entry.identity.includes("optional"))!.definition.routine as RoutineSnapshot)
        .arguments[0]?.default,
      "present",
    );
    const loaded = apply(catalog);
    for (const sql of [
      "SELECT project.dynamic(1)",
      "SELECT project.optional()",
      "SELECT project.rounded(1)",
      "SELECT project.lower(1)",
      "SELECT lookup(1)",
      "SELECT project.lookup()",
      "SELECT project.lookup(1,2)",
      "SELECT project.lookup(1) OVER ()",
      "SELECT * FROM project.dynamic(1)",
    ]) {
      const result = postgres().analyze(sql, loaded.schema);
      strict.ok(
        result.diagnostics.some((item) => item.code === "TSQ202"),
        sql,
      );
      strict.equal(result.columns[0]?.tsType, "unknown", sql);
    }
    const corrupt = createProjectCatalog({
      ...catalog,
      entries: catalog.entries.map((entry) => ({ ...entry, permission: "fixed-result" })),
    });
    strict.throws(() => apply(corrupt), /fixed result/u);
    strict.throws(
      () =>
        apply(
          createProjectCatalog({ ...catalog, entries: [{ ...catalog.entries[0]!, permission: "qualified-rule" }] }),
        ),
      /Unsupported/u,
    );
  });
  await it("requires qualified native identities and applies the selected runtime policy", () => {
    for (const identity of ["bigint", "project.int8", "pg_catalog.text"]) {
      const declared = routine("lookup");
      if (declared.result.kind !== "scalar") throw Error("Expected scalar fixture");
      const source = parseSchemaSnapshot({
        ...base,
        routines: { lookup: [{ ...declared, result: { ...declared.result, typeIdentity: identity } }] },
      });
      if (source.formatVersion !== 2) throw Error("Expected v2 fixture");
      const catalog = createPostgresProjectCatalog({ source, context, sql: ["SELECT project.lookup(1)"] });
      strict.equal(catalog.entries[0]?.permission, "query-only", identity);
      strict.throws(
        () =>
          apply(
            createProjectCatalog({
              ...catalog,
              entries: catalog.entries.map((entry) => ({ ...entry, permission: "fixed-result" })),
            }),
          ),
        /fixed result/u,
      );
    }
    const policy = { ...defaultPostgresTypePolicy, bigint: "string" as const };
    const configured = { ...context, typePolicyHash: calculateTypePolicyHash(policy) };
    const catalog = createPostgresProjectCatalog({
      source,
      context: configured,
      typePolicy: policy,
      sql: ["SELECT project.lookup(1)"],
    });
    const projected = applyProjectCatalogs({
      schema: { ...base, dialect: "postgres" as const },
      context: configured,
      typePolicy: policy,
      catalogs: [catalog],
      contributions: [createPostgresProjectCatalogContribution()],
    });
    const resolved = postgres({ typePolicy: policy }).analyze("SELECT project.lookup($1) AS value", projected.schema);
    strict.equal(resolved.columns[0]?.tsType, "string");
    strict.equal(resolved.parameters[0]?.tsType, "string");
    strict.equal(resolved.columns[0]?.nullable, true);
    strict.throws(() => createPostgresProjectCatalog({ source, context, typePolicy: policy, sql: [] }), /policy/u);
  });
  await it("reuses overloaded declarations only with exact native argument types", () => {
    const textOverload = routine("lookup", "text", {
      identity: "project.lookup(text)",
      arguments: [
        {
          name: "value",
          mode: "in",
          typeIdentity: "pg_catalog.text",
          databaseType: "text",
          tsType: "any",
          default: "none",
        },
      ],
    });
    const source = parseSchemaSnapshot({ ...base, routines: { lookup: [routine("lookup"), textOverload] } });
    if (source.formatVersion !== 2) throw Error("Expected v2 fixture");
    const projected = apply(
      createPostgresProjectCatalog({ source, context, sql: ["SELECT project.lookup(1::bigint)"] }),
    );
    for (const [sql, expected] of [
      ["SELECT project.lookup(1::bigint)", "bigint"],
      ["SELECT project.lookup('x'::text)", "string"],
      ["SELECT project.lookup(1::integer)", "unknown"],
      ["SELECT project.lookup($1)", "unknown"],
    ]) {
      const result = postgres().analyze(sql!, projected.schema);
      strict.equal(result.columns[0]?.tsType, expected, sql);
    }
  });
  await it("retains full overload families and refuses mixed permissions, collisions and namespace guesses", () => {
    const alternate = routine("lookup", "anyelement", {
      identity: "project.lookup(text)",
      polymorphicFamily: "anyelement",
    });
    const source = parseSchemaSnapshot({ ...base, routines: { lookup: [routine("lookup"), alternate] } });
    if (source.formatVersion !== 2) throw Error("Expected v2 fixture");
    const catalog = createPostgresProjectCatalog({ source, context, sql: ["SELECT project.lookup(1)"] });
    strict.equal(catalog.entries.length, 2);
    strict.ok(catalog.entries.every((entry) => entry.permission === "query-only"));
    strict.equal(postgres().analyze("SELECT project.lookup(1)", apply(catalog).schema).columns[0]?.tsType, "unknown");
    const reselected = createPostgresProjectCatalog({ source, context, sql: ["SELECT other.lookup(1)"] });
    strict.equal(reselected.entries.length, 0);
    const payload = catalog.entries[0]!;
    strict.throws(
      () => apply(createProjectCatalog({ ...catalog, entries: [{ ...payload, identity: "wrong" }] })),
      /identity/u,
    );
  });
});
