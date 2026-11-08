import {
  applyProjectCatalogs,
  createProjectCatalog,
  parseProjectCatalog,
  queryContractDigest,
} from "@typed-sql/analysis";
import {
  calculateSchemaHash,
  calculateTypePolicyHash,
  parseSchemaSnapshot,
  type RoutineSnapshot,
  upgradeSchemaSnapshotV1,
} from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { compileSource } from "../../compiler/src/index.js";
import { postgres, postgresServerEvidence } from "../src/analysis.js";
import { createPostgresProjectCatalog, createPostgresProjectCatalogContribution } from "../src/project-catalog.js";
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
