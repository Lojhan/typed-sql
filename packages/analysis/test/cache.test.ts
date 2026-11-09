import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import { readCacheFile, writeCacheFile } from "../src/cache-files.js";
import {
  type AnalysisCacheToken,
  type LiveAnalysisOutcome,
  openAnalysisCache,
  parseStaticQueryClaim,
  queryContractDigest,
  type RecordedAnalysisQuery,
} from "../src/index.js";
import { fixture, hash, runner } from "./helpers/live-fixture.js";

const run = promisify(execFile);
const signal = () => new AbortController().signal;
const negative: LiveAnalysisOutcome = { kind: "rejected", code: "invalid-query" };
const recorded = (request = fixture()): RecordedAnalysisQuery => ({
  candidate: request.candidate,
  context: request.staticClaim.context,
  adapter: request.adapter,
  connectionContext: request.connectionContext,
  policy: request.policy,
});
async function temporary(test: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-analysis-cache-"));
  try {
    await test(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}
function rehash(value: Record<string, unknown>) {
  const { digest: _, ...body } = value;
  return { ...body, digest: queryContractDigest(body) };
}
const child = async (
  directory: string,
  action: "publish" | "lookup" | "prune",
  sql: string,
  token?: AnalysisCacheToken,
) => {
  const script = `import {openAnalysisCache} from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
    import {fixture,hash,runner} from ${JSON.stringify(new URL("./helpers/live-fixture.ts", import.meta.url).href)};
    const cache=await openAnalysisCache({directory:process.argv[1],workspaceContext:hash});
    const request=fixture(process.argv[3]);
    const result=process.argv[2]==="publish" ? await cache.publish({token:JSON.parse(process.argv[4]),request,outcome:await runner(request,new AbortController().signal)}) : process.argv[2]==="lookup" ? await cache.lookup(request) : await cache.prune({retentionMs:0});
    process.stdout.write(JSON.stringify(result));`;
  const { stdout } = await run(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    script,
    directory,
    action,
    sql,
    JSON.stringify(token ?? null),
  ]);
  return JSON.parse(stdout);
};

await describe("owned disposable analysis cache", async () => {
  await it("looks up exact recorded contracts before loading an analyzer and fences changed static claims", async () => {
    await temporary(async (directory) => {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash });
      const request = fixture();
      const cold = await cache.lookupRecorded(recorded(request));
      strict.equal(cold.cached, undefined);
      const outcome = await runner(request, signal());
      strict.equal((await cache.publish({ token: cold.token, request, outcome })).status, "published");
      const hit = await cache.lookupRecorded(recorded(request));
      strict.equal(hit.cached?.outcome.kind, "usable-recorded-context");
      strict.equal(hit.cached?.freshness, "unverified");
      const { digest: _, ...claim } = request.staticClaim;
      const body = { ...claim, diagnostics: [{ code: "TSQ999", severity: "warning" as const }] };
      const changed = {
        ...request,
        staticClaim: parseStaticQueryClaim({ ...body, digest: queryContractDigest(body) }),
      };
      const fresh = await cache.lookup(changed);
      strict.equal(fresh.cached?.outcome.kind, "partial", "A known changed static claim requires requalification");
      strict.equal(
        fresh.token.requestKey,
        hit.token.requestKey,
        "Same candidate shares one publication fence across claims",
      );
      strict.notEqual(fresh.token.entryRevision, hit.token.entryRevision);
      strict.equal((await cache.lookupRecorded(recorded(request))).cached?.outcome.kind, "partial");
      strict.equal(
        (
          await cache.publish({
            token: fresh.token,
            request: changed,
            outcome: { kind: "partial", code: "unsupported-statement" },
          })
        ).status,
        "superseded",
      );
      strict.deepEqual((await cache.lookupRecorded(recorded(request))).cached?.outcome, {
        kind: "partial",
        code: "static-claim-changed",
      });
      strict.equal(
        (await cache.publish({ token: fresh.token, request: changed, outcome: negative })).status,
        "published",
      );
      strict.equal((await cache.publish({ token: hit.token, request, outcome })).status, "superseded");
      strict.deepEqual((await cache.lookupRecorded(recorded(request))).cached?.outcome, negative);
      for (const query of [
        { ...recorded(request), connectionContext: queryContractDigest("other endpoint") },
        { ...recorded(request), adapter: { ...request.adapter, version: "2" } },
        {
          ...recorded(request),
          context: { ...request.staticClaim.context, codecHash: queryContractDigest("other codec") },
        },
        { ...recorded(request), policy: { ...request.policy, requiredNativeFacets: [] } },
        { ...recorded(request), candidate: { ...request.candidate, columnSpans: [] } },
        recorded(fixture("SELECT 2 AS value")),
      ])
        strict.equal((await cache.lookupRecorded(query)).cached, undefined);
      await cache.invalidate();
      strict.equal((await cache.lookupRecorded(recorded(request))).cached, undefined);
    });
  });

  await it("reopens qualified evidence without a database and never persists source SQL or a fresh-remote claim", async () => {
    await temporary(async (directory) => {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash, now: () => 1234 });
      const request = fixture("SELECT 1 AS value /* private source literal */"),
        outcome = await runner(request, signal());
      const before = await cache.lookup(request);
      strict.equal(before.cached, undefined);
      strict.ok(Object.isFrozen(before.token));
      strict.equal((await cache.publish({ token: before.token, request, outcome })).status, "published");
      const reopened = await openAnalysisCache({ directory, workspaceContext: hash });
      const found = await reopened.lookup(request);
      strict.equal(found.cached?.outcome.kind, "usable-recorded-context");
      strict.equal(found.cached?.recordedAt, 1234);
      strict.equal(found.cached?.freshness, "unverified");
      strict.ok(Object.isFrozen(found.cached));
      const remote = await child(directory, "lookup", request.candidate.sql);
      strict.deepEqual(remote, found);
      for (const path of await files(directory)) {
        const text = await readFile(path, "utf8");
        strict.ok(!text.includes(request.candidate.sql));
        strict.ok(!text.includes("private source literal"));
        strict.ok(!text.includes('"tsType"'));
        strict.ok(!text.includes(directory));
      }
    });
  });
  await it("initializes one ownership namespace under concurrent process startup", async () => {
    await temporary(async (parent) => {
      const directory = join(parent, "fresh");
      const results = await Promise.all(
        Array.from({ length: 4 }, () => child(directory, "lookup", fixture().candidate.sql)),
      );
      strict.equal(new Set(results.map((result) => result.token.ownerInstance)).size, 1);
      strict.equal(new Set(results.map((result) => result.token.epoch)).size, 1);
    });
  });
  await it("retires all namespace evidence and old producers when a known stale context is published", async () => {
    await temporary(async (directory) => {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash });
      const first = fixture(),
        other = fixture("SELECT 2 AS value");
      const old = await cache.lookup(other);
      await cache.publish({
        token: (await cache.lookup(first)).token,
        request: first,
        outcome: await runner(first, signal()),
      });
      const stale = { kind: "stale-context", code: "context-changed" } as const;
      await cache.publish({ token: (await cache.lookup(first)).token, request: first, outcome: stale });
      strict.deepEqual((await cache.lookup(first)).cached?.outcome, stale);
      strict.deepEqual((await cache.lookup(other)).cached?.outcome, stale);
      strict.equal((await cache.publish({ token: old.token, request: other, outcome: negative })).status, "superseded");
      const fresh = await cache.lookup(other);
      strict.equal(
        (await cache.publish({ token: fresh.token, request: other, outcome: await runner(other, signal()) })).status,
        "published",
      );
      strict.equal((await cache.lookup(other)).cached?.outcome.kind, "usable-recorded-context");
      strict.equal((await cache.lookup(first)).cached, undefined);
    });
  });
  await it("stages immutable objects before publication and rejects interrupted or conflicting writes", async () => {
    await temporary(async (directory) => {
      const staging = join(directory, "staging"),
        target = join(directory, "object.json");
      await mkdir(staging);
      const write = (text: string, assertLock = async () => {}) =>
        writeCacheFile({ path: target, staging, text, limit: 1024, immutable: true, assertLock });
      await strict.rejects(
        () =>
          write("partial", async () => {
            throw Error("lease lost");
          }),
        /lease lost/u,
      );
      strict.deepEqual(await readdir(staging), []);
      await strict.rejects(() => readCacheFile(target, 1024), /ENOENT/u);
      await write("original");
      await write("original");
      await strict.rejects(() => write("different"), /Conflicting/u);
      strict.equal(await readCacheFile(target, 1024), "original");
      await strict.rejects(() => write("x".repeat(1025)), /byte limit/u);
      await writeFile(target, Buffer.from([0xff]));
      await strict.rejects(() => readCacheFile(target, 1024), /encoded data/u);
      strict.deepEqual(await readdir(staging), []);
    });
  });
  await it("fences competing producers, invalidation and ABA rewrites while permitting unrelated concurrent requests", async () => {
    await temporary(async (directory) => {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash });
      const request = fixture(),
        outcome = await runner(request, signal());
      const first = await cache.lookup(request),
        second = await cache.lookup(request);
      strict.equal((await cache.publish({ token: first.token, request, outcome })).status, "published");
      strict.equal((await cache.publish({ token: second.token, request, outcome })).status, "superseded");
      const current = await cache.lookup(request);
      strict.equal((await cache.publish({ token: current.token, request, outcome })).status, "published");
      strict.equal((await cache.publish({ token: current.token, request, outcome })).status, "superseded");
      const old = await cache.lookup(request);
      await cache.invalidate();
      strict.equal((await cache.lookup(request)).cached, undefined);
      strict.equal((await cache.publish({ token: old.token, request, outcome })).status, "superseded");
      const requests = [fixture("SELECT 2 AS value"), fixture("SELECT 3 AS value")];
      const tokens = await Promise.all(requests.map((value) => cache.lookup(value)));
      const results = await Promise.all(
        requests.map(async (value, index) =>
          cache.publish({ token: tokens[index]!.token, request: value, outcome: await runner(value, signal()) }),
        ),
      );
      strict.deepEqual(
        results.map((item) => item.status),
        ["published", "published"],
      );
      strict.equal((await cache.lookup(requests[0]!)).cached?.outcome.kind, "usable-recorded-context");
      strict.equal((await cache.lookup(requests[1]!)).cached?.outcome.kind, "usable-recorded-context");
    });
  });
  await it("does not starve concurrent cache handles within one process", async () => {
    await temporary(async (directory) => {
      await openAnalysisCache({ directory, workspaceContext: hash });
      const writers = await Promise.all(
        Array.from({ length: 16 }, () => openAnalysisCache({ directory, workspaceContext: hash })),
      );
      const results = await Promise.allSettled(
        writers.map(async (cache, writer) => {
          for (let item = 0; item < 8; item++) {
            const request = fixture(`SELECT ${writer * 8 + item} AS value`);
            const { token } = await cache.lookup(request);
            strict.equal((await cache.publish({ token, request, outcome: negative })).status, "published");
          }
        }),
      );
      strict.deepEqual(
        results.map(({ status }) => status),
        Array.from({ length: 16 }, () => "fulfilled"),
      );
      for (let item = 0; item < 128; item++)
        strict.equal((await writers[0]!.lookup(fixture(`SELECT ${item} AS value`))).cached?.outcome.kind, "rejected");
    });
  });
  await it("serializes real process writers and preserves all referenced objects during a competing prune", async () => {
    await temporary(async (directory) => {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash });
      const request = fixture(),
        captured = await cache.lookup(request);
      const results = await Promise.all([
        child(directory, "publish", request.candidate.sql, captured.token),
        child(directory, "publish", request.candidate.sql, captured.token),
      ]);
      strict.deepEqual(results.map((item) => item.status).sort(), ["published", "superseded"]);
      const requests = [fixture("SELECT 2 AS value"), fixture("SELECT 3 AS value")];
      const tokens = await Promise.all(requests.map((value) => cache.lookup(value)));
      await Promise.all([
        ...requests.map((value, index) => child(directory, "publish", value.candidate.sql, tokens[index]!.token)),
        child(directory, "prune", request.candidate.sql),
      ]);
      for (const value of [request, ...requests])
        strict.equal((await cache.lookup(value)).cached?.outcome.kind, "usable-recorded-context");
    });
  });
  await it("namespaces project inputs and protects another namespace during maintenance", async () => {
    await temporary(async (directory) => {
      const first = await openAnalysisCache({ directory, workspaceContext: hash });
      const second = await openAnalysisCache({ directory, workspaceContext: queryContractDigest("other project") });
      const request = fixture(),
        outcome = await runner(request, signal()),
        initial = await first.lookup(request);
      strict.equal((await first.publish({ token: initial.token, request, outcome })).status, "published");
      strict.equal((await second.lookup(request)).cached, undefined);
      await strict.rejects(() => second.publish({ token: initial.token, request, outcome }), /token/u);
      await second.invalidate();
      await second.prune({ retentionMs: 0 });
      strict.equal((await first.lookup(request)).cached?.outcome.kind, "usable-recorded-context");
      await writeFile(join(directory, "unrelated.json"), "keep");
      await writeFile(join(directory, "staging", "unrelated.tmp"), "keep");
      await first.invalidate();
      const pruned = await first.prune({ retentionMs: 0 });
      strict.equal(pruned.removed, 2);
      strict.equal((await first.prune({ retentionMs: 0 })).removed, 0);
      strict.equal(await readFile(join(directory, "unrelated.json"), "utf8"), "keep");
      strict.equal(await readFile(join(directory, "staging", "unrelated.tmp"), "utf8"), "keep");
    });
  });
  await it("persists sanitized negative outcomes but rejects transient failures and mismatched query contracts", async () => {
    await temporary(async (directory) => {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash }),
        request = fixture();
      const first = await cache.lookup(request);
      await cache.publish({ token: first.token, request, outcome: negative });
      strict.deepEqual((await cache.lookup(request)).cached?.outcome, negative);
      const current = await cache.lookup(request);
      strict.equal(
        (
          await cache.publish({
            token: current.token,
            request,
            outcome: { kind: "partial", code: "unsupported-statement" },
          })
        ).status,
        "superseded",
      );
      strict.deepEqual((await cache.lookup(request)).cached?.outcome, negative);
      await strict.rejects(
        () =>
          cache.publish({
            token: current.token,
            request,
            outcome: { kind: "unavailable", code: "network", retry: "transport" },
          }),
        /Transient/u,
      );
      strict.deepEqual((await cache.lookup(request)).cached?.outcome, negative);
      await strict.rejects(
        async () =>
          cache.publish({
            token: current.token,
            request,
            outcome: await runner(fixture("SELECT 2 AS value"), signal()),
          }),
        /qualification/u,
      );
      await strict.rejects(
        () => cache.publish({ token: { ...current.token, epoch: "../escape" }, request, outcome: negative }),
        /identity/u,
      );
      await strict.rejects(
        () =>
          cache.publish({
            token: { ...current.token, requestKey: queryContractDigest("other") },
            request,
            outcome: negative,
          }),
        /token/u,
      );
      await strict.rejects(
        () =>
          cache.publish({
            token: { ...current.token, formatVersion: 2 } as unknown as AnalysisCacheToken,
            request,
            outcome: negative,
          }),
        /version/u,
      );
    });
  });
  await it("enforces count, byte and clock limits without overwriting usable entries", async () => {
    await temporary(async (directory) => {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash, maxEntries: 1 });
      const first = fixture(),
        second = fixture("SELECT 2 AS value");
      await cache.publish({ token: (await cache.lookup(first)).token, request: first, outcome: negative });
      strict.equal(
        (await cache.publish({ token: (await cache.lookup(second)).token, request: second, outcome: negative })).status,
        "capacity",
      );
      const brokenClock = await openAnalysisCache({ directory, workspaceContext: hash, now: () => -1 });
      await strict.rejects(
        async () =>
          brokenClock.publish({ token: (await brokenClock.lookup(first)).token, request: first, outcome: negative }),
        /timestamp/u,
      );
      await strict.rejects(() => openAnalysisCache({ directory, workspaceContext: hash, maxEntries: 0 }), /limits/u);
      await strict.rejects(() => openAnalysisCache({ directory, workspaceContext: "bad" }), /identity/u);
      await strict.rejects(() => cache.prune({ retentionMs: -1 }), /retention/u);
      await cache.invalidate();
      const tiny = await openAnalysisCache({ directory, workspaceContext: hash, maxObjectBytes: 1024, maxBytes: 1024 });
      strict.equal(
        (
          await tiny.publish({
            token: (await tiny.lookup(first)).token,
            request: first,
            outcome: await runner(first, signal()),
          })
        ).status,
        "capacity",
      );
    });
  });
  await it("bounds namespace metadata and object sizes and preserves referenced objects above a reduced budget", async () => {
    await temporary(async (directory) => {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash, maxNamespaces: 1 });
      await strict.rejects(
        () => openAnalysisCache({ directory, workspaceContext: queryContractDigest("other"), maxNamespaces: 1 }),
        /namespace limit/u,
      );
      const first = fixture(),
        outcome = await runner(first, signal());
      const small = await openAnalysisCache({ directory, workspaceContext: hash, maxObjectBytes: 1024 });
      strict.equal(
        (await small.publish({ token: (await small.lookup(first)).token, request: first, outcome })).status,
        "capacity",
      );
      await cache.publish({ token: (await cache.lookup(first)).token, request: first, outcome });
      const reduced = await openAnalysisCache({ directory, workspaceContext: hash, maxBytes: 8 * 1024 * 1024 });
      const orphan = join(directory, "queries/objects", `${queryContractDigest("orphan")}.json`);
      await writeFile(orphan, "x".repeat(8 * 1024 * 1024));
      strict.equal((await reduced.prune()).removed, 1);
      strict.equal((await reduced.lookup(first)).cached?.outcome.kind, "usable-recorded-context");
      await writeFile(orphan, "x".repeat(8 * 1024 * 1024));
      strict.equal(
        (await reduced.publish({ token: (await reduced.lookup(first)).token, request: first, outcome: negative }))
          .status,
        "published",
      );
      strict.deepEqual((await reduced.lookup(first)).cached?.outcome, negative);
      const pruned = await reduced.prune();
      strict.ok(pruned.removed >= 1);
      strict.equal((await reduced.lookup(first)).cached?.outcome.kind, "rejected");
      const staleToken = (await cache.lookup(first)).token;
      await rm(join(directory, "indexes", `${hash}.json`));
      const reopened = await openAnalysisCache({ directory, workspaceContext: hash });
      strict.equal((await reopened.publish({ token: staleToken, request: first, outcome })).status, "superseded");
    });
  });
  await it("recovers conservative reservations after an interrupted writer and never retains disproved evidence under that pressure", async () => {
    await temporary(async (directory) => {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash, maxBytes: 8 * 1024 * 1024 });
      const request = fixture(),
        outcome = await runner(request, signal());
      await cache.publish({ token: (await cache.lookup(request)).token, request, outcome });
      // A killed publisher can reserve bytes without installing its staged payload/index.
      const usagePath = join(directory, "usage.json");
      await writeFile(usagePath, JSON.stringify(rehash({ formatVersion: 1, bytes: 16 * 1024 * 1024 })));
      const other = fixture("SELECT 2 AS value");
      strict.equal(
        (await cache.publish({ token: (await cache.lookup(other)).token, request: other, outcome: negative })).status,
        "capacity",
      );
      strict.equal(
        (await cache.publish({ token: (await cache.lookup(request)).token, request, outcome: negative })).status,
        "published",
      );
      strict.deepEqual((await cache.lookup(request)).cached?.outcome, negative);
      await cache.prune({ retentionMs: 0 });
      strict.equal(
        (await cache.publish({ token: (await cache.lookup(other)).token, request: other, outcome: negative })).status,
        "published",
      );
      await writeFile(usagePath, JSON.stringify(rehash({ formatVersion: 2, bytes: 0 })));
      await strict.rejects(() => openAnalysisCache({ directory, workspaceContext: hash }), /ledger/u);
      await strict.rejects(() => cache.lookup(request), /ledger/u);
      await writeFile(usagePath, JSON.stringify({ formatVersion: 1, bytes: 0, digest: hash }));
      await strict.rejects(() => openAnalysisCache({ directory, workspaceContext: hash }), /reservation digest/u);
      await rm(usagePath);
      await openAnalysisCache({ directory, workspaceContext: hash });
      strict.ok(JSON.parse(await readFile(usagePath, "utf8")).bytes > 0);
    });
  });
  await it("rejects corrupt objects, indexes, ownership and missing closures without treating them as hits", async () => {
    await temporary(async (directory) => {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash }),
        request = fixture(),
        outcome = await runner(request, signal());
      await cache.publish({ token: (await cache.lookup(request)).token, request, outcome });
      if (outcome.kind !== "usable-recorded-context") throw Error("Missing fixture contract");
      const objectPath = join(directory, "queries/objects", `${outcome.contract.digest}.json`),
        original = await readFile(objectPath, "utf8");
      await writeFile(objectPath, "{");
      await strict.rejects(() => cache.lookup(request), SyntaxError);
      await writeFile(objectPath, original);
      const contextPath = join(directory, "contexts", `${queryContractDigest(request.staticClaim.context)}.json`),
        originalContext = await readFile(contextPath, "utf8");
      await writeFile(
        contextPath,
        JSON.stringify({ ...request.staticClaim.context, codecHash: queryContractDigest("wrong") }),
      );
      await strict.rejects(() => cache.lookup(request), /context digest/u);
      await writeFile(contextPath, originalContext);
      await rm(objectPath);
      await strict.rejects(() => cache.lookup(request), /ENOENT/u);
      await writeFile(objectPath, original);
      const indexPath = join(directory, "indexes", `${hash}.json`),
        originalIndex = await readFile(indexPath, "utf8"),
        parsed = JSON.parse(originalIndex);
      for (const invalid of [
        { ...parsed, formatVersion: 2 },
        { ...parsed, epoch: "bad" },
        { ...parsed, extra: true },
        { ...parsed, digest: hash },
        rehash({ ...parsed, entries: [parsed.entries[0], parsed.entries[0]] }),
        rehash({ ...parsed, entries: [{ ...parsed.entries[0], recordedAt: -1 }] }),
        rehash({ ...parsed, entries: [{ ...parsed.entries[0], contextHash: queryContractDigest("wrong") }] }),
      ]) {
        await writeFile(indexPath, JSON.stringify(invalid));
        await strict.rejects(() => cache.lookup(request));
      }
      await writeFile(indexPath, originalIndex);
      const ownershipPath = join(directory, "ownership.json"),
        ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
      await writeFile(ownershipPath, JSON.stringify({ ...ownership, owner: "someone else" }));
      await strict.rejects(() => cache.lookup(request), /ownership/u);
      await writeFile(ownershipPath, JSON.stringify({ ...ownership, instance: queryContractDigest("replacement") }));
      await strict.rejects(() => cache.lookup(request), /instance/u);
    });
  });
  await it("refuses unowned directories, symlink escape paths, nonregular objects and oversized payloads", async () => {
    await temporary(async (parent) => {
      const directory = join(parent, "cache"),
        outside = join(parent, "outside");
      await mkdir(directory);
      await mkdir(outside);
      await writeFile(join(directory, "foreign"), "keep");
      await strict.rejects(() => openAnalysisCache({ directory, workspaceContext: hash }), /unowned/u);
      await rm(join(directory, "foreign"));
      await symlink(outside, join(parent, "linked"));
      await strict.rejects(
        () => openAnalysisCache({ directory: join(parent, "linked"), workspaceContext: hash }),
        /Unsafe/u,
      );
      const cache = await openAnalysisCache({ directory, workspaceContext: hash }),
        request = fixture(),
        outcome = await runner(request, signal());
      await cache.publish({ token: (await cache.lookup(request)).token, request, outcome });
      if (outcome.kind !== "usable-recorded-context") throw Error("Missing contract");
      const objectPath = join(directory, "queries/objects", `${outcome.contract.digest}.json`);
      await rm(objectPath);
      await writeFile(join(outside, "secret"), "external data");
      await symlink(join(outside, "secret"), objectPath);
      await strict.rejects(() => readCacheFile(objectPath, 1024));
      await strict.rejects(() => cache.lookup(request));
      await strict.rejects(() => cache.prune({ retentionMs: 0 }), /Unsafe/u);
      await rm(objectPath);
      await mkdir(objectPath);
      await strict.rejects(() => cache.lookup(request), /regular/u);
      await rm(objectPath, { recursive: true });
      await writeFile(objectPath, "x".repeat(8 * 1024 * 1024 + 1));
      await strict.rejects(() => cache.lookup(request), /byte limit/u);
      await rm(join(directory, "contexts"), { recursive: true });
      await symlink(outside, join(directory, "contexts"));
      await strict.rejects(() => cache.lookup(request), /Unsafe/u);
    });
  });
  await it("recovers a stale crashed-writer lock and prunes orphaned staging without touching unrelated files", async () => {
    await temporary(async (directory) => {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash });
      const lockPath = join(directory, "locks/publication.lock");
      await mkdir(lockPath);
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);
      strict.equal((await cache.lookup(fixture())).cached, undefined);
      const abandoned = join(directory, "staging", "12345678-1234-1234-1234-123456789abc.tmp");
      await writeFile(abandoned, "interrupted write");
      await utimes(abandoned, old, old);
      strict.equal((await cache.prune({ retentionMs: 0 })).removed, 1);
      await symlink(directory, lockPath);
      await strict.rejects(() => cache.lookup(fixture()), /lock/u);
    });
  });
});
