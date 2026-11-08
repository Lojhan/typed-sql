import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { type AnalysisCache, type AnalysisContextScope, openAnalysisCache, queryContractDigest } from "../src/index.js";
import { context, request, result } from "./helpers/host-fixture.js";
import { hash } from "./helpers/live-fixture.js";

const { databaseContextHash: _, ...identity } = context;
const scope: AnalysisContextScope = {
  ...identity,
  connectionContext: request.connectionContext,
  adapter: request.adapter,
};
async function temporary(test: (cache: AnalysisCache, directory: string) => Promise<void>, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-context-head-"));
  try {
    await test(await openAnalysisCache({ directory, workspaceContext: hash, ...options }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
await describe("recorded context selection", async () => {
  await it("reopens exact scope observations offline and protects them across pruning and query publication", async () => {
    await temporary(async (cache, directory) => {
      const before = await cache.lookupContext(scope);
      strict.equal(before.recorded, undefined);
      strict.equal((await cache.publishContext({ token: before.token, scope, context })).status, "published");
      await cache.publish({ token: (await cache.lookup(request)).token, request, outcome: result });
      const reopened = await openAnalysisCache({ directory, workspaceContext: hash });
      const found = await reopened.lookupContext(scope);
      strict.equal(await reopened.areTokensCurrent([found.token]), true);
      strict.deepEqual(found.recorded?.context, context);
      strict.equal(found.recorded?.status, "usable");
      strict.equal(found.recorded?.freshness, "unverified");
      strict.ok(Object.isFrozen(found.recorded));
      const otherNamespace = await openAnalysisCache({
        directory,
        workspaceContext: queryContractDigest("other workspace"),
      });
      strict.equal((await otherNamespace.lookupContext(scope)).recorded, undefined);
      await otherNamespace.prune({ retentionMs: 0 });
      strict.deepEqual((await reopened.lookupContext(scope)).recorded?.context, context);
      for (const changed of [
        { ...scope, connectionContext: queryContractDigest("other target") },
        { ...scope, adapter: { ...scope.adapter, version: "2" } },
        { ...scope, profileHash: queryContractDigest("other profile") },
        { ...scope, schemaHash: queryContractDigest("other schema") },
      ])
        strict.equal((await reopened.lookupContext(changed)).recorded, undefined);
    });
  });
  await it("fences competing observations, retirement and invalidation without allowing an older epoch to be reselected", async () => {
    await temporary(async (cache) => {
      const first = await cache.lookupContext(scope),
        concurrent = await cache.lookupContext(scope);
      strict.equal((await cache.publishContext({ token: first.token, scope, context })).status, "published");
      strict.equal((await cache.publishContext({ token: concurrent.token, scope, context })).status, "superseded");
      const old = await cache.lookupContext(scope);
      await cache.retireContext(context);
      strict.equal(await cache.areTokensCurrent([old.token]), false);
      strict.equal((await cache.lookupContext(scope)).recorded?.status, "stale");
      strict.equal((await cache.publishContext({ token: old.token, scope, context })).status, "superseded");
      const fresh = { ...context, databaseContextHash: queryContractDigest("new observed epoch") };
      strict.equal(
        (await cache.publishContext({ token: (await cache.lookupContext(scope)).token, scope, context: fresh })).status,
        "published",
      );
      strict.deepEqual((await cache.lookupContext(scope)).recorded?.context, fresh);
      const captured = await cache.lookupContext(scope);
      await cache.invalidate();
      strict.equal((await cache.lookupContext(scope)).recorded, undefined);
      strict.equal((await cache.publishContext({ token: captured.token, scope, context })).status, "superseded");
    });
  });
  await it("reflects query-reported context staleness and rejects mismatched context authority", async () => {
    await temporary(async (cache) => {
      await cache.publishContext({ token: (await cache.lookupContext(scope)).token, scope, context });
      await cache.publish({
        token: (await cache.lookup(request)).token,
        request,
        outcome: { kind: "stale-context", code: "context-changed" },
      });
      strict.equal((await cache.lookupContext(scope)).recorded?.status, "stale");
      const token = (await cache.lookupContext(scope)).token;
      await strict.rejects(
        cache.publishContext({ token, scope, context: { ...context, codecHash: queryContractDigest("wrong") } }),
        /installed profile/u,
      );
      await strict.rejects(
        cache.publishContext({ token: { ...token, requestKey: queryContractDigest("wrong") }, scope, context }),
        /token differs/u,
      );
      for (const invalid of [
        null,
        [],
        {},
        { ...scope, adapter: { id: "", version: "1" } },
        { ...scope, adapter: [] },
        { ...scope, connectionContext: "wrong" },
        { ...scope, schemaHash: "wrong" },
      ])
        await strict.rejects(cache.lookupContext(invalid as AnalysisContextScope));
    });
  });
  await it("enforces admission bounds without replacing an observed selection", async () => {
    await temporary(
      async (cache) => {
        await cache.publishContext({ token: (await cache.lookupContext(scope)).token, scope, context });
        const other = { ...scope, connectionContext: queryContractDigest("other") };
        strict.equal(
          (await cache.publishContext({ token: (await cache.lookupContext(other)).token, scope: other, context }))
            .status,
          "capacity",
        );
        strict.deepEqual((await cache.lookupContext(scope)).recorded?.context, context);
      },
      { maxEntries: 1 },
    );
    await temporary(async (cache, directory) => {
      const tiny = await openAnalysisCache({ directory, workspaceContext: hash, maxObjectBytes: 1024, maxBytes: 1024 });
      strict.equal(
        (await tiny.publishContext({ token: (await cache.lookupContext(scope)).token, scope, context })).status,
        "capacity",
      );
      strict.equal((await cache.lookupContext(scope)).recorded, undefined);
    });
  });
  await it("validates indexed observation structure, referenced data and configured scope", async () => {
    await temporary(async (cache, directory) => {
      await cache.publishContext({ token: (await cache.lookupContext(scope)).token, scope, context });
      const path = join(directory, "indexes", `${hash}.json`),
        original = JSON.parse(await readFile(path, "utf8"));
      const contextPath = join(directory, "contexts", `${queryContractDigest(context)}.json`);
      await writeFile(
        contextPath,
        JSON.stringify({ ...context, databaseContextHash: queryContractDigest("wrong object") }),
      );
      await strict.rejects(cache.lookupContext(scope), /head digest differs/u);
      await writeFile(contextPath, JSON.stringify(context));
      for (const heads of [
        null,
        [...original.heads, ...original.heads],
        [{ ...original.heads[0], status: "fresh" }],
        [{ ...original.heads[0], observedAt: -1 }],
      ]) {
        const { digest: _, ...body } = { ...original, heads };
        await writeFile(path, JSON.stringify({ ...body, digest: queryContractDigest(body) }));
        await strict.rejects(cache.lookupContext(scope));
      }
      await writeFile(path, JSON.stringify(original));
      strict.deepEqual((await cache.lookupContext(scope)).recorded?.context, context);
    });
  });
});
