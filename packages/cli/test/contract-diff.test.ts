import { describe, it, strict } from "poku";
import {
  createProjectCatalog,
  createProjectCatalogClosure,
  createQueryContract,
  queryContractDigest,
} from "../../analysis/src/index.js";
import { postgresProfile } from "../../postgres/src/profile.js";
import { buildContractExportDiff } from "../src/contract-diff.js";
import { context } from "./helpers/contract-fixture.js";

const sql = "SELECT 1 AS value";
const contract = (text = sql, nullable = false) =>
  createQueryContract({
    sql: text,
    context,
    origin: "offline-rule",
    valuePlan: {
      dialect: "postgres",
      typePolicyHash: context.typePolicyHash,
      columns: [{ name: "value", type: "number", databaseType: "integer", nullable }],
      parameters: [],
    },
  });
await describe("semantic query export review", async () => {
  await it("retains ordered old/new facts and treats changed SQL as added/removed without inventing equivalence", () => {
    const old = contract(),
      changed = contract(sql, true),
      removed = contract("SELECT 2 AS value"),
      added = contract("SELECT 3 AS value");
    const diff = buildContractExportDiff({ before: [old, removed], after: [added, changed] });
    const update = diff.queries.find((change) => change.kind === "changed")!;
    strict.ok(update.facets.includes("columns"));
    strict.equal(update.before[0]!.columns[0]!.nullable, false);
    strict.equal(update.after[0]!.columns[0]!.nullable, true);
    strict.equal(diff.queries.filter((change) => change.kind === "added").length, 1);
    strict.equal(diff.queries.filter((change) => change.kind === "removed").length, 1);
    strict.ok(!JSON.stringify(diff).includes("SELECT"), "Review metadata must not add SQL text to artifacts");
    strict.deepEqual(buildContractExportDiff({ before: [old, old], after: [old] }).queries, []);
    const moved = createQueryContract({
      sql,
      context,
      origin: "offline-rule",
      valuePlan: old.valuePlan,
      columnSpans: [{ start: 7, end: 8 }],
    });
    strict.deepEqual(buildContractExportDiff({ before: [old], after: [moved] }).queries, []);
    strict.throws(() =>
      buildContractExportDiff({ before: [{ ...old, digest: queryContractDigest("wrong") }], after: [] }),
    );
  });
  await it("retains reusable declaration permissions, parameter metadata and raw definitions", () => {
    const schema = { formatVersion: 1, dialect: "postgres", tables: {} } as const;
    const owner = { id: "test/catalog", version: "1", grammar: context.grammar, apply: () => schema };
    const closure = (nativeType: string) =>
      createProjectCatalogClosure({
        schema,
        context,
        typePolicy: postgresProfile().defaultTypePolicy,
        contributions: [owner],
        catalogs: [
          createProjectCatalog({
            context,
            owner: { id: owner.id, version: owner.version },
            entries: [
              {
                kind: "routine",
                identity: "custom",
                permission: "declaration-only",
                evidenceDigest: queryContractDigest(nativeType),
                definition: { params: [{ name: "input", nativeType }] },
              },
            ],
          }),
        ],
      });
    const diff = buildContractExportDiff({
      before: [],
      after: [],
      beforeCatalogs: closure("integer"),
      afterCatalogs: closure("bigint"),
    });
    strict.equal(diff.declarations[0]!.kind, "changed");
    strict.ok(diff.declarations[0]!.facets.includes("definition"));
    strict.deepEqual(diff.declarations[0]!.after[0]!.definition, { params: [{ name: "input", nativeType: "bigint" }] });
  });
  await it("keeps incomplete native evidence visible without inferring an independent qualification", () => {
    const source = contract(sql, true);
    const native = createQueryContract({
      sql,
      context,
      origin: "native-description",
      valuePlan: source.valuePlan,
      nativeEvidence: {
        adapter: { id: "test/native", version: "1" },
        consistency: { mechanism: "guarded", scope: "test" },
        resultKind: "rows",
        parameters: [],
        parameterOccurrences: [],
        columns: [
          {
            name: "value",
            nativeType: { status: "known", value: { name: "integer", complete: false } },
            runtimeType: { status: "known", value: "number" },
            nullable: { status: "unknown", reason: "not reported" },
            descriptor: {},
          },
        ],
      },
    });
    const diff = buildContractExportDiff({ before: [], after: [native] });
    strict.equal(diff.unresolvedFacets.length, 1);
    strict.equal(diff.unresolvedFacets[0]!.facets[0]!.facet, "qualification");
    strict.deepEqual(diff.queries[0]!.after[0]!.nativeEvidence!.columns[0]!.nullable, {
      status: "unknown",
      reason: "not reported",
    });
  });
});
