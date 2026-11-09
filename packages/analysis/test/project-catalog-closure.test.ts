import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  createAnalysisContextScope,
  createProjectCatalog,
  createProjectCatalogClosure,
  createQueryContract,
  exportQueryContracts,
  loadFrozenContractView,
  loadQueryContractContext,
  loadQueryContractInputs,
  materializeProjectCatalogClosure,
  type ProjectCatalogContribution,
  parseProjectCatalogClosure,
  queryContractDigest,
  queryContractManifestDigest,
} from "../src/index.js";
import { configuration, context, contract, profile, request, schema } from "./helpers/host-fixture.js";

const owner: ProjectCatalogContribution<typeof schema, Record<string, unknown>> = {
  id: "vendor/catalog",
  version: "1",
  grammar: context.grammar,
  apply(base) {
    return {
      ...base,
      functions: {
        long_tail: {
          name: "long_tail",
          argumentTypes: [],
          returnType: "number",
          databaseReturnType: "integer",
          nullable: true,
        },
      },
    };
  },
};
const catalog = createProjectCatalog({
  context,
  owner: { id: owner.id, version: owner.version },
  entries: [
    {
      kind: "routine",
      identity: "long_tail()",
      permission: "fixed-result",
      evidenceDigest: queryContractDigest("native-source"),
      definition: { result: "integer" },
    },
  ],
});
const closure = createProjectCatalogClosure({
  schema,
  context,
  typePolicy: {},
  catalogs: [catalog],
  contributions: [owner],
});
const projected = materializeProjectCatalogClosure({ closure, schema, typePolicy: {}, contributions: [owner] });
const recorded = createQueryContract({
  sql: request.candidate.sql,
  context: closure.context,
  origin: "offline-rule",
  valuePlan: contract.valuePlan,
});
const scope = createAnalysisContextScope({ profile, schema, configuration });
const selection = { scope, context: closure.context, projectCatalogs: closure };
async function temporary(test: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-project-catalog-closure-"));
  try {
    await test(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function repack(changes: Record<string, unknown>) {
  const { digest: _, ...body } = { ...closure, ...changes };
  return { ...body, digest: queryContractDigest(body) };
}
await describe("durable project catalog closures", async () => {
  await it("recomputes enriched schema and identities with independently installed owners", () => {
    strict.notEqual(projected.context.schemaHash, context.schemaHash);
    strict.notEqual(projected.context.profileHash, context.profileHash);
    strict.deepEqual(parseProjectCatalogClosure(JSON.parse(JSON.stringify(closure))), closure);
    strict.ok(Object.isFrozen(closure.catalogs));
    strict.throws(
      () => materializeProjectCatalogClosure({ closure, schema, typePolicy: {}, contributions: [] }),
      /interpreter/u,
    );
    strict.throws(
      () =>
        materializeProjectCatalogClosure({
          closure,
          schema,
          typePolicy: {},
          contributions: [{ ...owner, version: "2" }],
        }),
      /interpreter/u,
    );
    strict.throws(
      () =>
        materializeProjectCatalogClosure({
          closure,
          schema,
          typePolicy: {},
          contributions: [{ ...owner, apply: (base) => base }],
        }),
      /interpretation/u,
    );
    const forged = parseProjectCatalogClosure(
      repack({ context: { ...closure.context, schemaHash: queryContractDigest("forged") } }),
    );
    strict.throws(
      () => materializeProjectCatalogClosure({ closure: forged, schema, typePolicy: {}, contributions: [owner] }),
      /interpretation/u,
    );
    strict.throws(
      () =>
        materializeProjectCatalogClosure({ closure, schema, typePolicy: { changed: true }, contributions: [owner] }),
      /policy/u,
    );
  });
  await it("rejects changed provenance, duplicate catalogs and inconsistent identity transitions", () => {
    for (const input of [
      null,
      { ...closure, digest: context.schemaHash },
      repack({ formatVersion: 2 }),
      repack({ extra: true }),
      repack({ catalogs: [] }),
      repack({ catalogs: Array(65).fill(catalog) }),
      repack({ catalogs: [catalog, catalog] }),
      repack({ catalogs: [{ ...catalog, digest: context.schemaHash }] }),
      repack({ baseContext: { ...context, databaseContextHash: queryContractDigest("other-epoch") } }),
      repack({ context: { ...closure.context, codecHash: queryContractDigest("other-codec") } }),
      repack({ context }),
    ])
      strict.throws(() => parseProjectCatalogClosure(input));
    strict.throws(
      () => createProjectCatalogClosure({ schema, context, typePolicy: {}, catalogs: [], contributions: [] }),
      /count/u,
    );
  });
  await it("publishes catalogs and contracts through one atomic manifest and rematerializes frozen inputs", async () => {
    await temporary(async (directory) => {
      const digest = await exportQueryContracts(directory, [recorded], { selection });
      strict.equal(digest, queryContractManifestDigest([recorded], { selection }));
      const inputs = await loadQueryContractInputs(directory, scope);
      strict.deepEqual(inputs.context, projected.context);
      strict.deepEqual(inputs.projectCatalogs, closure);
      strict.ok(inputs.files.includes(join(directory, "catalogs", `${closure.digest}.json`)));
      strict.deepEqual(await loadQueryContractContext(directory, scope), projected.context);
      strict.equal(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).formatVersion, 2);
      const frozen = {
        profile,
        schema,
        configuration: {
          ...configuration,
          mode: "frozen" as const,
          qualification: { ...configuration.qualification, mode: "hybrid" as const },
        },
        directory,
      };
      await strict.rejects(loadFrozenContractView(frozen), /installed interpreters/u);
      const view = await loadFrozenContractView({ ...frozen, projectCatalogContributions: [owner] });
      const { context: _pinned, ...automatic } = frozen.configuration;
      await strict.rejects(
        loadFrozenContractView({
          ...frozen,
          configuration: {
            ...automatic,
            identity: { ...configuration.identity, profileHash: queryContractDigest("different-owner") },
          },
          projectCatalogContributions: [owner],
        }),
        /base scope/u,
      );
      strict.deepEqual(view.schema, projected.schema);
      strict.deepEqual(view.context, projected.context);
      strict.equal(view.dialect.analyze(request.candidate.sql, view.schema).diagnostics.length, 0);
      strict.ok(view.dialect.analyze(request.candidate.sql, schema).diagnostics.length > 0);
      await strict.rejects(
        exportQueryContracts(directory, [recorded], { selection: { ...selection, context } }),
        /project catalog context/u,
      );
      await strict.rejects(
        exportQueryContracts(directory, [recorded], {
          selection: { ...selection, scope: { ...scope, schemaHash: closure.context.schemaHash } },
        }),
        /Observed context/u,
      );
      await strict.rejects(
        exportQueryContracts(directory, [contract], {
          beforeCommit: async () => {
            throw Error("inputs changed");
          },
        }),
        /inputs changed/u,
      );
      strict.equal((await loadQueryContractInputs(directory, scope)).manifestDigest, digest);
      await rm(join(directory, "catalogs", `${closure.digest}.json`));
      await strict.rejects(loadQueryContractInputs(directory), /ENOENT/u);
      await strict.rejects(loadQueryContractContext(directory, scope), /ENOENT/u);
    });
  });
  await it("rejects a replaced catalog object and a manifest pointing to another context", async () => {
    await temporary(async (directory) => {
      await exportQueryContracts(directory, [recorded], { selection });
      await writeFile(
        join(directory, "catalogs", `${closure.digest}.json`),
        JSON.stringify(repack({ context: { ...closure.context, schemaHash: queryContractDigest("other-schema") } })),
      );
      await strict.rejects(loadQueryContractInputs(directory), /closure differs/u);
      await strict.rejects(exportQueryContracts(directory, [recorded], { selection }), /immutable/u);
    });
  });
});
