import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  type AnalysisCache,
  createNativeLiveAnalysisRunner,
  createPersistentLiveAnalysisRunner,
  type LiveAnalysisOutcome,
  openAnalysisCache,
} from "../src/index.js";
import { adapter, context, fixture, hash, owner, runner } from "./helpers/live-fixture.js";

const request = fixture();
const signal = () => new AbortController().signal;
async function temporary(test: (cache: AnalysisCache, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-persistent-live-"));
  try {
    await test(await openAnalysisCache({ directory, workspaceContext: hash }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
await describe("persistent live producer", async () => {
  await it("acquires on every explicit live run and supports analyzer-free restart lookup", async () => {
    await temporary(async (cache, directory) => {
      let calls = 0;
      const run = createPersistentLiveAnalysisRunner({
        cache,
        run: async (...args) => {
          calls++;
          return runner(...args);
        },
      });
      strict.equal((await run(request, signal())).kind, "usable-recorded-context");
      strict.equal((await run(request, signal())).kind, "usable-recorded-context");
      strict.equal(calls, 2);
      const reopened = await openAnalysisCache({ directory, workspaceContext: hash });
      const found = await reopened.lookupRecorded({
        candidate: request.candidate,
        context: request.staticClaim.context,
        adapter: request.adapter,
        policy: request.policy,
        connectionContext: request.connectionContext,
      });
      strict.equal(found.cached?.outcome.kind, "usable-recorded-context");
      strict.equal(found.cached?.freshness, "unverified");
    });
  });
  await it("preserves recorded evidence on outages and retires known conflicts", async () => {
    await temporary(async (cache) => {
      await createPersistentLiveAnalysisRunner({ cache, run: runner })(request, signal());
      const original = await cache.lookup(request);
      const outage = { kind: "unavailable", code: "transport-down", retry: "transport" } as const;
      strict.deepEqual(
        await createPersistentLiveAnalysisRunner({ cache, run: async () => outage })(request, signal()),
        outage,
      );
      strict.deepEqual(await cache.lookup(request), original);
      const configured = { ...outage, retry: "change" as const };
      strict.deepEqual(
        await createPersistentLiveAnalysisRunner({ cache, run: async () => configured })(request, signal()),
        configured,
      );
      strict.deepEqual(await cache.lookup(request), original);
      const conflict = { kind: "conflict", code: "known-conflict" } as const;
      strict.deepEqual(
        await createPersistentLiveAnalysisRunner({ cache, run: async () => conflict })(request, signal()),
        conflict,
      );
      strict.deepEqual((await cache.lookup(request)).cached?.outcome, conflict);
    });
  });
  await it("uses adapter-owned classification through acquisition and persistence, with explicit host overrides", async () => {
    await temporary(async (cache) => {
      await createPersistentLiveAnalysisRunner({ cache, run: runner })(request, signal());
      const original = await cache.lookup(request);
      const outage = { kind: "unavailable", code: "fixture-outage", retry: "transport" } as const;
      const selected = adapter({
        classifyError: () => outage,
        open: async () => ({
          context: async () => context,
          describe: async () => {
            throw Error("private driver message");
          },
          close: async () => {},
        }),
      });
      const native = createNativeLiveAnalysisRunner({ adapter: selected, contribution: owner });
      strict.deepEqual(await createPersistentLiveAnalysisRunner({ cache, run: native })(request, signal()), outage);
      strict.deepEqual(await cache.lookup(request), original);
      const rejection = { kind: "rejected", code: "fixture-rejected" } as const;
      const override = createNativeLiveAnalysisRunner({
        adapter: selected,
        contribution: owner,
        classifyError: () => rejection,
      });
      strict.deepEqual(
        await createPersistentLiveAnalysisRunner({ cache, run: override })(request, signal()),
        rejection,
      );
      strict.deepEqual((await cache.lookup(request)).cached?.outcome, rejection);
      const changed = adapter({
        classifyError(error) {
          strict.ok(error instanceof AggregateError);
          if (error instanceof AggregateError) strict.equal(error.errors.length, 2);
          return { kind: "stale-context", code: "fixture-context-changed" };
        },
        open: async () => ({
          context: async () => context,
          describe: async () => {
            throw Error("known context change");
          },
          close: async () => {
            throw Error("cleanup outage");
          },
        }),
      });
      strict.equal(
        (await createNativeLiveAnalysisRunner({ adapter: changed, contribution: owner })(request, signal())).kind,
        "stale-context",
      );
    });
  });
  await it("fences invalidated producers and does not publish after cancellation or malformed output", async () => {
    await temporary(async (cache) => {
      const outcome = await runner(request, signal());
      const stale = createPersistentLiveAnalysisRunner({
        cache,
        run: async () => {
          await cache.invalidate();
          return outcome;
        },
      });
      strict.deepEqual(await stale(request, signal()), {
        kind: "unavailable",
        code: "cache-publication-superseded",
        retry: "change",
      });
      strict.equal((await cache.lookup(request)).cached, undefined);
      const control = new AbortController();
      const cancelled = createPersistentLiveAnalysisRunner({
        cache,
        run: async () => {
          control.abort();
          return outcome;
        },
      });
      await strict.rejects(cancelled(request, control.signal), { name: "AbortError" });
      strict.equal((await cache.lookup(request)).cached, undefined);
      await strict.rejects(
        createPersistentLiveAnalysisRunner({
          cache,
          run: async () => ({ kind: "bad" }) as unknown as LiveAnalysisOutcome,
        })(request, signal()),
      );
      strict.equal((await cache.lookup(request)).cached, undefined);
      await strict.rejects(createPersistentLiveAnalysisRunner({ cache, run: runner })(request, control.signal), {
        name: "AbortError",
      });
    });
  });
  await it("allows fresh qualified evidence when persistence cannot admit it", async () => {
    await temporary(async (cache) => {
      const outcome = await runner(request, signal());
      const full: AnalysisCache = { ...cache, publish: async () => ({ status: "capacity" }) };
      strict.deepEqual(
        await createPersistentLiveAnalysisRunner({ cache: full, run: async () => outcome })(request, signal()),
        outcome,
      );
      strict.equal((await cache.lookup(request)).cached, undefined);
    });
  });
});
