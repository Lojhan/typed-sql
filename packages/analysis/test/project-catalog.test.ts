import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import {
  applyProjectCatalogs,
  createProjectCatalog,
  type ProjectCatalogContribution,
  type ProjectCatalogEntry,
  parseProjectCatalog,
  queryContractDigest,
} from "../src/index.js";

const hash = queryContractDigest("project-catalog-fixture");
const schema = { formatVersion: 1 as const, dialect: "vendor/project", tables: {} };
const policy = {};
const context = {
  grammar: { id: schema.dialect, version: "1" },
  profileHash: hash,
  schemaHash: calculateSchemaHash(schema),
  typePolicyHash: calculateTypePolicyHash(policy),
  databaseContextHash: hash,
  codecHash: hash,
  interpreterHash: hash,
};
const entry: ProjectCatalogEntry = {
  kind: "routine",
  identity: "vendor.lookup(integer)",
  permission: "fixed-result",
  evidenceDigest: hash,
  definition: { nativeResult: "integer" },
};
const owner: ProjectCatalogContribution<typeof schema, typeof policy> = {
  id: "vendor/project-catalog",
  version: "1",
  grammar: context.grammar,
  apply(base) {
    return base;
  },
};
const catalog = () =>
  createProjectCatalog({ context, owner: { id: owner.id, version: owner.version }, entries: [entry] });
const apply = (changes: Partial<Parameters<typeof applyProjectCatalogs<typeof schema, typeof policy>>[0]> = {}) =>
  applyProjectCatalogs({
    schema,
    context,
    typePolicy: policy,
    catalogs: [catalog()],
    contributions: [owner],
    ...changes,
  });
function repack(changes: Record<string, unknown>) {
  const { digest: _, ...body } = { ...catalog(), ...changes };
  return { ...body, digest: queryContractDigest(body) };
}
await describe("recorded project catalog interpretation", async () => {
  await it("preserves metadata through bounded JSON and binds the selected catalogs into context identity", () => {
    const source = catalog();
    strict.deepEqual(parseProjectCatalog(JSON.parse(JSON.stringify(source))), source);
    strict.ok(Object.isFrozen(source.entries[0]!.definition));
    const result = apply();
    strict.equal(result.context.schemaHash, context.schemaHash);
    strict.notEqual(result.context.profileHash, context.profileHash);
    strict.equal(result.context.databaseContextHash, context.databaseContextHash);
    const second = createProjectCatalog({
      context,
      owner: source.owner,
      entries: [{ ...entry, identity: "vendor.other" }],
    });
    strict.deepEqual(apply({ catalogs: [second, source] }), apply({ catalogs: [source, second] }));
    strict.deepEqual(apply({ catalogs: [], contributions: [] }), { schema, context });
  });
  await it("binds contributed schema changes and discards stale generator claims", () => {
    const projected = apply({
      contributions: [
        {
          ...owner,
          apply(base) {
            return {
              ...base,
              functions: {
                lookup: {
                  name: "lookup",
                  argumentTypes: ["integer"],
                  returnType: "number",
                  databaseReturnType: "integer",
                  nullable: true,
                },
              },
              metadata: { generatorVersion: "old", schemaHash: hash, typePolicyHash: hash },
            };
          },
        },
      ],
    });
    strict.notEqual(projected.context.schemaHash, context.schemaHash);
    strict.equal(projected.context.schemaHash, calculateSchemaHash(projected.schema));
    strict.equal("metadata" in projected.schema, false);
    strict.ok("functions" in projected.schema);
  });
  await it("rejects changed bytes, executable payloads, unknown fields, permissions and duplicate identities", () => {
    strict.throws(() => parseProjectCatalog({ ...catalog(), digest: hash }), /digest/u);
    strict.throws(() => parseProjectCatalog({ ...catalog(), extra: true }), /fields/u);
    for (const changed of [
      { ...entry, permission: "trust-me" },
      { ...entry, evidenceDigest: "bad" },
      { ...entry, identity: "" },
      { ...entry, definition: [] },
      { ...entry, definition: { run() {} } },
      {
        ...entry,
        definition: {
          get value() {
            throw Error("Getter must not run");
          },
        },
      },
    ])
      strict.throws(
        () => createProjectCatalog({ context, owner: catalog().owner, entries: [changed as ProjectCatalogEntry] }),
        TypeError,
      );
    strict.throws(() => createProjectCatalog({ context, owner: catalog().owner, entries: [entry, entry] }), /unique/u);
    strict.throws(
      () =>
        parseProjectCatalog(
          repack({
            entries: [
              { ...entry, identity: "z" },
              { ...entry, identity: "a" },
            ],
          }),
        ),
      /sorted/u,
    );
    strict.throws(() => parseProjectCatalog(repack({ entries: Array(4097).fill(entry) })), RangeError);
    strict.throws(() => parseProjectCatalog(repack({ owner: { id: owner.id, version: "1", extra: "x" } })), /fields/u);
    strict.throws(() => parseProjectCatalog(repack({ entries: [{ ...entry, extra: true }] })), /fields/u);
  });
  await it("fails closed on context, policy, ownership and grammar changes before invoking an interpreter", () => {
    let calls = 0;
    const counted = {
      ...owner,
      apply(base: typeof schema) {
        calls++;
        return base;
      },
    };
    for (const field of [
      "profileHash",
      "schemaHash",
      "typePolicyHash",
      "databaseContextHash",
      "codecHash",
      "interpreterHash",
    ] as const) {
      const changed = createProjectCatalog({
        context: { ...context, [field]: queryContractDigest(field) },
        owner: catalog().owner,
        entries: [entry],
      });
      strict.throws(() => apply({ catalogs: [changed], contributions: [counted] }), /context/u);
    }
    strict.throws(() => apply({ contributions: [] }), /unavailable/u);
    strict.throws(() => apply({ contributions: [{ ...counted, version: "2" }] }), /unavailable/u);
    strict.throws(() => apply({ contributions: [counted, counted] }), /Conflicting/u);
    strict.throws(() => apply({ catalogs: [catalog(), catalog()], contributions: [counted] }), /ownership/u);
    strict.throws(
      () => apply({ contributions: [{ ...counted, grammar: { ...context.grammar, version: "2" } }] }),
      /grammar/u,
    );
    strict.throws(() => apply({ typePolicy: { changed: true } }), /policy/u);
    strict.throws(() => apply({ schema: { ...schema, tables: { new: { name: "new", columns: {} } } } }), /schema/u);
    strict.equal(calls, 0);
    strict.throws(
      () => apply({ contributions: [{ ...owner, apply: (base) => ({ ...base, dialect: "other" }) }] }),
      /changed grammar/u,
    );
    strict.throws(() => apply({ catalogs: Array(65).fill(catalog()) }), RangeError);
  });
});
