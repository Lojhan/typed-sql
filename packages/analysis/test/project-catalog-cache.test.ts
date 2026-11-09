import { mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import {
  type AnalysisCache,
  createProjectCatalog,
  createProjectCatalogClosure,
  inspectAnalysisCache,
  openAnalysisCache,
  type ProjectCatalogClosure,
  queryContractDigest,
} from "../src/index.js";

const hash = queryContractDigest("catalog-cache-test");
const schema = { formatVersion: 1 as const, dialect: "vendor/cache", tables: {} };
const context = {
  grammar: { id: schema.dialect, version: "1" },
  profileHash: hash,
  schemaHash: calculateSchemaHash(schema),
  typePolicyHash: calculateTypePolicyHash({}),
  databaseContextHash: hash,
  codecHash: hash,
  interpreterHash: hash,
};
const { databaseContextHash: _, ...identity } = context;
const scope = { ...identity, connectionContext: hash, adapter: { id: "vendor/native", version: "1" } };
const query = { scope, sql: ["select private_function(42)", "select private_function(7)"] };
function closure(definition = "integer", base = context): ProjectCatalogClosure {
  const owner = { id: "vendor/catalog", version: "1" };
  return createProjectCatalogClosure({
    schema,
    context: base,
    typePolicy: {},
    catalogs: [
      createProjectCatalog({
        context: base,
        owner,
        entries: [
          {
            kind: "routine",
            identity: "private_function(integer)",
            permission: "fixed-result",
            evidenceDigest: hash,
            definition: { result: definition },
          },
        ],
      }),
    ],
    contributions: [{ ...owner, grammar: base.grammar, apply: (value) => value }],
  });
}
async function temporary(run: (directory: string, cache: AnalysisCache) => Promise<void>, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-catalog-cache-"));
  try {
    await run(directory, await openAnalysisCache({ directory, workspaceContext: hash, ...options }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function observe(cache: AnalysisCache, base = context) {
  const result = await cache.publishContext({ scope, context: base, token: (await cache.lookupContext(scope)).token });
  strict.equal(result.status, "published");
  if (result.status !== "published") throw Error("Expected context publication");
  return result.token;
}
async function publish(cache: AnalysisCache, value = closure()) {
  const baseToken = await observe(cache, value.baseContext);
  return cache.publishProjectCatalog({
    query,
    baseToken,
    closure: value,
    token: (await cache.lookupProjectCatalog(query)).token,
  });
}

await describe("persisted project catalog selections", async () => {
  await it("recovers a selection after reopening without storing SQL, and isolates target identities", async () => {
    await temporary(async (directory, cache) => {
      strict.equal((await cache.lookupProjectCatalog(query)).cached, undefined);
      strict.equal((await publish(cache)).status, "published");
      strict.deepEqual((await inspectAnalysisCache({ directory, workspaceContext: hash })).indexedCatalogs, [
        { digest: closure().digest, contextHash: queryContractDigest(closure().baseContext) },
      ]);
      const reopened = await openAnalysisCache({ directory, workspaceContext: hash });
      const hit = await reopened.lookupProjectCatalog({ scope, sql: [...query.sql].reverse().concat(query.sql) });
      strict.deepEqual(hit.cached?.closure, closure());
      strict.equal(hit.cached?.freshness, "unverified");
      for (const changed of [
        { ...scope, connectionContext: queryContractDigest("other") },
        { ...scope, typePolicyHash: queryContractDigest("policy") },
        { ...scope, schemaHash: queryContractDigest("schema") },
      ])
        strict.equal((await reopened.lookupProjectCatalog({ scope: changed, sql: query.sql })).cached, undefined);
      strict.equal(
        (await reopened.lookupProjectCatalog({ scope, sql: ["select private_function(43)"] })).cached,
        undefined,
      );
      const indexes = await readdir(join(directory, "indexes"));
      const index = await readFile(join(directory, "indexes", indexes[0]!), "utf8");
      for (const sql of query.sql) strict.equal(index.includes(sql), false);
      strict.equal((await reopened.prune({ retentionMs: 0 })).removed, 0);
      strict.deepEqual((await reopened.lookupProjectCatalog(query)).cached?.closure, closure());
    });
  });
  await it("requires independent base observation and fences competing captures and invalidation", async () => {
    await temporary(async (_directory, cache) => {
      const cold = await cache.lookupProjectCatalog(query);
      const unobserved = await cache.lookupContext(scope);
      strict.equal(
        (
          await cache.publishProjectCatalog({
            query,
            token: cold.token,
            baseToken: unobserved.token,
            closure: closure(),
          })
        ).status,
        "superseded",
      );
      const baseToken = await observe(cache);
      const first = await cache.publishProjectCatalog({ query, token: cold.token, baseToken, closure: closure() });
      strict.equal(first.status, "published");
      strict.equal(
        (await cache.publishProjectCatalog({ query, token: cold.token, baseToken, closure: closure("text") })).status,
        "superseded",
      );
      const same = await publish(cache);
      if (first.status !== "published" || same.status !== "published") throw Error("Expected publication");
      strict.equal(first.token.entryRevision, same.token.entryRevision);
      strict.equal(await cache.areTokensCurrent([first.token]), true);
      const replacement = await publish(cache, closure("text"));
      strict.equal(replacement.status, "published");
      strict.equal(await cache.areTokensCurrent([first.token]), false);
      const token = (await cache.lookupProjectCatalog(query)).token;
      await cache.invalidate();
      strict.equal(
        (await cache.publishProjectCatalog({ query, token, baseToken, closure: closure() })).status,
        "superseded",
      );
      strict.equal((await cache.lookupProjectCatalog(query)).cached, undefined);
      strict.ok((await cache.prune({ retentionMs: 0 })).removed > 0);
    });
  });
  await it("rejects drift, foreign tokens, malformed selections, and modified or unsafe objects", async () => {
    await temporary(async (directory, cache) => {
      await publish(cache);
      const selected = await cache.lookupProjectCatalog(query);
      const baseToken = (await cache.lookupContext(scope)).token;
      await strict.rejects(
        cache.publishProjectCatalog({ query, token: baseToken, baseToken, closure: closure() }),
        /token/u,
      );
      for (const sql of [[""], [42], Array(4097).fill("select 1")])
        await strict.rejects(cache.lookupProjectCatalog({ scope, sql: sql as string[] }), /selection/u);
      const file = join(directory, "catalogs/objects", `${closure().digest}.json`);
      const original = await readFile(file, "utf8");
      await writeFile(file, original.replace("integer", "modified"));
      await strict.rejects(cache.lookupProjectCatalog(query), /digest/u);
      await unlink(file);
      await strict.rejects(cache.lookupProjectCatalog(query), /ENOENT/u);
      const target = join(directory, "outside.json");
      await writeFile(target, original);
      await symlink(target, file);
      await strict.rejects(cache.lookupProjectCatalog(query));
      await unlink(file);
      await writeFile(file, original);
      await observe(cache, { ...context, databaseContextHash: queryContractDigest("changed") });
      strict.equal(await cache.areTokensCurrent([selected.token]), false);
      strict.equal((await cache.lookupProjectCatalog(query)).cached, undefined);
      await strict.rejects(
        cache.publishProjectCatalog({
          query,
          token: selected.token,
          baseToken,
          closure: closure("integer", { ...context, profileHash: queryContractDigest("foreign-profile") }),
        }),
        /scope|profile/u,
      );
    });
  });
  await it("honors shared namespace references and byte and entry quotas", async () => {
    await temporary(async (directory, cache) => {
      await publish(cache);
      const second = await openAnalysisCache({ directory, workspaceContext: queryContractDigest("second") });
      await publish(second);
      await cache.invalidate();
      await cache.prune({ retentionMs: 0 });
      strict.deepEqual((await second.lookupProjectCatalog(query)).cached?.closure, closure());
      await second.retireContext(context);
      strict.equal((await second.lookupProjectCatalog(query)).cached, undefined);
      strict.ok((await second.prune({ retentionMs: 0 })).removed > 0);
    });
    await temporary(
      async (_directory, cache) => {
        await publish(cache);
        const different = { ...query, sql: ["select other(1)"] };
        strict.equal(
          (
            await cache.publishProjectCatalog({
              query: different,
              token: (await cache.lookupProjectCatalog(different)).token,
              baseToken: (await cache.lookupContext(scope)).token,
              closure: closure(),
            })
          ).status,
          "capacity",
        );
      },
      { maxEntries: 1 },
    );
    await temporary(async (directory, cache) => {
      const baseToken = await observe(cache);
      const usage = JSON.parse(await readFile(join(directory, "usage.json"), "utf8"));
      const bounded = await openAnalysisCache({
        directory,
        workspaceContext: hash,
        maxObjectBytes: 1024,
        maxBytes: Math.max(1024, usage.bytes + 1),
      });
      strict.equal(
        (
          await bounded.publishProjectCatalog({
            query,
            baseToken,
            token: (await bounded.lookupProjectCatalog(query)).token,
            closure: closure(),
          })
        ).status,
        "capacity",
      );
    });
  });
});
