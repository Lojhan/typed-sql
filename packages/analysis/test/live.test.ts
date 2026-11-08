import { describe, it, strict } from "poku";
import { unknownQuerySemantics } from "../../core/src/index.js";
import {
  acquireNativeQueryContract,
  type ContractReconciliationContribution,
  createLiveAnalysisScheduler,
  createNativeLiveAnalysisRunner,
  createStaticQueryClaim,
  type LiveAnalysisClock,
  type LiveAnalysisOutcome,
  type LiveAnalysisRequest,
  type NativeContractAdapter,
  type NativeQueryContractEvidence,
  queryContractDigest,
} from "../src/index.js";

function clock() {
  let now = 0,
    sequence = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  const api: LiveAnalysisClock = {
    now: () => now,
    random: () => 0.5,
    after(ms, callback) {
      const id = ++sequence;
      tasks.set(id, { at: now + ms, callback });
      return () => {
        tasks.delete(id);
      };
    },
  };
  return {
    api,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...tasks]
          .filter(([, item]) => item.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].at;
        tasks.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    get pending() {
      return tasks.size;
    },
  };
}
async function settle() {
  for (let count = 0; count < 16; count++) await Promise.resolve();
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const hash = queryContractDigest("fixture");
const context = {
  grammar: { id: "vendor/live", version: "1" },
  profileHash: hash,
  schemaHash: hash,
  databaseContextHash: hash,
  typePolicyHash: hash,
  codecHash: hash,
  interpreterHash: hash,
};
const evidence: NativeQueryContractEvidence = {
  adapter: { id: "vendor/native", version: "1" },
  consistency: { mechanism: "snapshot", scope: "fixture" },
  resultKind: "rows",
  parameters: [],
  parameterOccurrences: [],
  columns: [
    {
      name: "value",
      nativeType: { status: "known", value: { name: "integer", complete: true } },
      runtimeType: { status: "known", value: "number" },
      nullable: { status: "known", value: false, precision: "exact" },
      descriptor: {},
    },
  ],
};
const owner: ContractReconciliationContribution = {
  id: "vendor/reconciliation",
  version: "1",
  grammar: context.grammar,
  classify: () => ({ status: "resolved", rule: "fixture", reason: "Independent fixture" }),
  compare: () => ({ status: "compatible", staticStatus: "known", rule: "fixture", reason: "Equal fixture facts" }),
};
function fixture(sql = "SELECT 1 AS value", connectionContext = hash): LiveAnalysisRequest {
  const range = { start: 0, end: sql.length, line: 1, column: 1 };
  return {
    connectionContext,
    adapter: evidence.adapter,
    candidate: { sql, parameterOccurrences: [], columnSpans: [{ start: 7, end: 8 }] },
    staticClaim: createStaticQueryClaim({
      sql,
      context,
      analysis: {
        columns: [
          { name: "value", tsType: "number", runtimeType: "number", databaseType: "integer", nullable: false, range },
        ],
        parameters: [],
        diagnostics: [],
        resultKind: "rows",
        semantics: unknownQuerySemantics(range, "fixture"),
      },
    }),
    policy: {
      mode: "native-required",
      owner: { id: owner.id, version: owner.version },
      requiredNativeFacets: ["runtime-type"],
    },
  };
}
function adapter(patch: Partial<NativeContractAdapter> = {}): NativeContractAdapter {
  return {
    ...evidence.adapter,
    grammar: context.grammar,
    accept: () => ({ accepted: true }),
    open: async () => ({ context: async () => context, describe: async () => evidence, close: async () => {} }),
    ...patch,
  };
}
const runner = createNativeLiveAnalysisRunner({ adapter: adapter(), contribution: owner });
const ticket = (document = "file:///query.ts", documentVersion = 0) => ({
  document,
  documentVersion,
  inputGeneration: 0,
  contextGeneration: 0,
  policyGeneration: 0,
});
const input = (request = fixture(), document?: string, documentVersion?: number) => ({
  request,
  ticket: ticket(document, documentVersion),
  queryId: "query",
});
const unavailable: LiveAnalysisOutcome = { kind: "unavailable", code: "network", retry: "transport" };

await describe("live analysis publication and fencing", async () => {
  await it("debounces, shares work, publishes immutable contracts and avoids callback resubscription loops", async () => {
    const time = clock();
    let calls = 0,
      deliveries = 0,
      views = 0;
    const scheduler = createLiveAnalysisScheduler({
      clock: time.api,
      run: async (...args) => {
        calls++;
        return runner(...args);
      },
      onView: () => {
        views++;
      },
    });
    const first = scheduler.subscribe(input(), () => {});
    const second = scheduler.subscribe(input(fixture(), "file:///second.ts"), () => {});
    await settle();
    strict.equal(first.state.kind, "pending");
    time.advance(299);
    strict.equal(calls, 0);
    time.advance(1);
    await settle();
    strict.equal(calls, 1);
    strict.equal(second.state.kind, "usable-recorded-context");
    strict.equal(scheduler.view.contracts.length, 1);
    strict.ok(Object.isFrozen(scheduler.view.contracts));
    strict.equal(views, 1);
    const listen = () => {
      deliveries++;
      scheduler.subscribe(input(), listen);
    };
    scheduler.subscribe(input(), listen);
    await settle();
    // The same document/query/stamp already received this state; replacing a host callback is inert.
    strict.equal(deliveries, 0);
    first.cancel();
    strict.equal(scheduler.view.contracts.length, 1);
    second.cancel();
    scheduler.closeDocument(ticket().document);
    strict.equal(scheduler.view.contracts.length, 0);
    await scheduler.close();
    strict.equal(time.pending, 0);
  });
  await it("cancels only the final shared subscriber and holds a lease until a noncooperative adapter settles", async () => {
    const time = clock(),
      pending = deferred<LiveAnalysisOutcome>();
    const signals: AbortSignal[] = [];
    const scheduler = createLiveAnalysisScheduler({
      clock: time.api,
      debounceMs: 0,
      maxActive: 1,
      run: async (_, signal) => {
        signals.push(signal);
        return pending.promise;
      },
    });
    const first = scheduler.subscribe(input(), () => {});
    const second = scheduler.subscribe(input(fixture(), "second"), () => {});
    scheduler.subscribe(input(fixture("SELECT 2 AS value"), "third"), () => {});
    first.cancel();
    strict.equal(signals[0]!.aborted, false);
    second.cancel();
    strict.equal(signals[0]!.aborted, true);
    strict.equal(signals.length, 1);
    let closed = false;
    const closing = scheduler.close().then(() => {
      closed = true;
    });
    await settle();
    strict.equal(closed, false);
    pending.resolve(await runner(fixture(), new AbortController().signal));
    await closing;
    strict.equal(scheduler.view.contracts.length, 0);
    strict.equal(signals.length, 1);
  });
  await it("fences document versions and all project generations synchronously, including late successful results", async () => {
    const time = clock(),
      pending = deferred<LiveAnalysisOutcome>();
    const scheduler = createLiveAnalysisScheduler({ clock: time.api, debounceMs: 0, run: () => pending.promise });
    const old = scheduler.subscribe(input(), () => {
      throw Error("stale callback");
    });
    scheduler.subscribe(input(fixture("SELECT 2 AS value"), undefined, 1), () => {});
    strict.equal(old.state.kind, "stale-input");
    strict.equal(scheduler.subscribe(input(), () => {}).state.kind, "stale-input");
    scheduler.advance({ inputGeneration: 1, contextGeneration: 1, policyGeneration: 1 });
    strict.equal(scheduler.view.contracts.length, 0);
    strict.equal(scheduler.subscribe(input(), () => {}).state.kind, "stale-input");
    strict.throws(
      () => scheduler.advance({ inputGeneration: 0, contextGeneration: 1, policyGeneration: 1 }),
      /backwards/u,
    );
    pending.resolve(await runner(fixture(), new AbortController().signal));
    await settle();
    strict.equal(scheduler.view.contracts.length, 0);
    await scheduler.close();
  });
  await it("retains matching last-good evidence during transport outages but clears it for known rejection", async () => {
    const time = clock();
    let result = await runner(fixture(), new AbortController().signal),
      calls = 0;
    const scheduler = createLiveAnalysisScheduler({
      clock: time.api,
      debounceMs: 0,
      run: async () => {
        calls++;
        return result;
      },
    });
    const handle = scheduler.subscribe(input(), () => {});
    await settle();
    strict.equal(scheduler.view.contracts.length, 1);
    result = unavailable;
    scheduler.retry(handle.key);
    await settle();
    strict.equal(handle.state.kind, "unavailable");
    strict.equal(scheduler.view.contracts.length, 1);
    time.advance(999);
    strict.equal(calls, 2);
    time.advance(1);
    await settle();
    strict.equal(calls, 3);
    time.advance(1999);
    strict.equal(calls, 3);
    time.advance(1);
    await settle();
    strict.equal(calls, 4);
    result = { kind: "rejected", code: "invalid-query" };
    scheduler.retry(handle.key);
    await settle();
    strict.equal(scheduler.view.contracts.length, 0);
    time.advance(100000);
    await settle();
    strict.equal(calls, 5);
    await scheduler.close();
  });
  await it("deadlines abort work without releasing its concurrency slot or accepting a late result", async () => {
    const time = clock(),
      pending = deferred<LiveAnalysisOutcome>();
    let calls = 0;
    const scheduler = createLiveAnalysisScheduler({
      clock: time.api,
      debounceMs: 0,
      deadlineMs: 100,
      maxActive: 1,
      run: async (_, signal) => {
        calls++;
        if (calls === 1) {
          signal.addEventListener("abort", () => {});
          return pending.promise;
        }
        return { kind: "partial", code: "fixture" };
      },
    });
    const handle = scheduler.subscribe(input(), () => {});
    time.advance(100);
    strict.deepEqual(handle.state, { kind: "unavailable", code: "native-deadline", retry: "transport" });
    time.advance(1000);
    strict.equal(calls, 1);
    pending.resolve(await runner(fixture(), new AbortController().signal));
    await settle();
    strict.equal(calls, 2);
    strict.equal(scheduler.view.contracts.length, 0);
    strict.equal(handle.state.kind, "partial");
    await scheduler.close();
  });
  await it("bounds context concurrency and queue pressure, permits explicit recovery and isolates observer failures", async () => {
    const time = clock(),
      jobs: ReturnType<typeof deferred<LiveAnalysisOutcome>>[] = [];
    let errors = 0;
    const scheduler = createLiveAnalysisScheduler({
      clock: time.api,
      debounceMs: 0,
      concurrencyPerContext: 1,
      maxActive: 2,
      maxQueued: 1,
      maxRecords: 1,
      onObserverError: () => {
        errors++;
        throw Error("observer error handler");
      },
      run: async () => {
        const job = deferred<LiveAnalysisOutcome>();
        jobs.push(job);
        return job.promise;
      },
    });
    const first = scheduler.subscribe(input(), () => {
      throw Error("observer");
    });
    const evicted = scheduler.subscribe(input(fixture("SELECT 2 AS value"), "second"), () => {});
    const third = scheduler.subscribe(input(fixture("SELECT 3 AS value"), "third"), () => {});
    const fourth = scheduler.subscribe(
      input(fixture("SELECT 4 AS value", queryContractDigest("other-context")), "fourth"),
      () => {},
    );
    strict.equal(jobs.length, 2);
    strict.equal(evicted.state.kind, "unavailable");
    await settle();
    strict.ok(errors > 0);
    first.cancel();
    jobs[0]!.resolve({ kind: "partial", code: "fixture" });
    await settle();
    strict.equal(jobs.length, 3);
    jobs[2]!.resolve({ kind: "partial", code: "fixture" });
    jobs[1]!.resolve({ kind: "partial", code: "fixture" });
    await settle();
    strict.equal(third.state.kind, "partial");
    strict.equal(fourth.state.kind, "partial");
    scheduler.subscribe(input(fixture("SELECT 2 AS value"), "second"), () => {});
    strict.equal(jobs.length, 4);
    jobs[3]!.resolve({ kind: "partial", code: "fixture" });
    await settle();
    scheduler.closeDocument("second");
    scheduler.subscribe(input(fixture("SELECT 2 AS value"), "second", 0), () => {});
    strict.equal(jobs.length, 5);
    jobs[4]!.resolve({ kind: "partial", code: "fixture" });
    await settle();
    await scheduler.close();
  });
  await it("does not abort active work when the same host resubscribes and validates qualified output identity", async () => {
    const time = clock(),
      pending = deferred<LiveAnalysisOutcome>();
    let signal!: AbortSignal;
    const scheduler = createLiveAnalysisScheduler({
      clock: time.api,
      debounceMs: 0,
      run: async (_, current) => {
        signal = current;
        return pending.promise;
      },
    });
    const old = scheduler.subscribe(input(), () => {});
    const fresh = scheduler.subscribe(input(), () => {});
    old.cancel();
    strict.equal(signal.aborted, false);
    strict.equal(old.state.kind, "stale-input");
    pending.resolve(await runner(fixture("SELECT 2 AS value"), new AbortController().signal));
    await settle();
    strict.deepEqual(fresh.state, { kind: "unavailable", code: "live-runner-error", retry: "change" });
    strict.equal(scheduler.view.contracts.length, 0);
    await scheduler.close();
  });
  await it("caps retry delays, tolerates broken jitter and stops transport retry after cancellation", async () => {
    const time = clock();
    let calls = 0;
    const scheduler = createLiveAnalysisScheduler({
      clock: {
        ...time.api,
        random: () => {
          throw Error("bad jitter");
        },
      },
      debounceMs: 0,
      run: async () => {
        calls++;
        return unavailable;
      },
    });
    const handle = scheduler.subscribe(input(), () => {});
    await settle();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = calls;
      time.advance(delay - 1);
      await settle();
      strict.equal(calls, before);
      time.advance(1);
      await settle();
      strict.equal(calls, before + 1);
    }
    strict.ok(Object.isFrozen(handle.state));
    handle.cancel();
    strict.equal(time.pending, 0);
    time.advance(60000);
    await settle();
    strict.equal(calls, 8);
    await scheduler.close();
  });
  await it("invalidates an already published contract immediately on a context change", async () => {
    const time = clock();
    const scheduler = createLiveAnalysisScheduler({ clock: time.api, debounceMs: 0, run: runner });
    const handle = scheduler.subscribe(input(), () => {});
    await settle();
    const before = scheduler.view;
    strict.equal(before.contracts.length, 1);
    scheduler.advance({ inputGeneration: 0, contextGeneration: 1, policyGeneration: 0 });
    strict.equal(scheduler.view.contracts.length, 0);
    strict.ok(scheduler.view.generation > before.generation);
    strict.equal(handle.state.kind, "stale-input");
    await scheduler.close();
  });
  await it("treats conflicting active artifacts as a conflict instead of choosing by recency", async () => {
    const time = clock();
    const altered = createNativeLiveAnalysisRunner({
      adapter: adapter({
        open: async () => ({
          context: async () => context,
          describe: async () => ({ ...evidence, consistency: { mechanism: "snapshot", scope: "other observation" } }),
          close: async () => {},
        }),
      }),
      contribution: owner,
    });
    const scheduler = createLiveAnalysisScheduler({
      clock: time.api,
      debounceMs: 0,
      run: (request, signal) =>
        request.connectionContext === hash ? runner(request, signal) : altered(request, signal),
    });
    const first = scheduler.subscribe(input(), () => {});
    const second = scheduler.subscribe(
      input(fixture(undefined, queryContractDigest("other connection")), "second"),
      () => {},
    );
    await settle();
    strict.equal(scheduler.view.contracts.length, 0);
    strict.equal(first.state.kind, "conflict");
    strict.equal(second.state.kind, "conflict");
    await scheduler.close();
  });
  await it("uses ordinary cancellable timers when no test clock is provided", async () => {
    const scheduler = createLiveAnalysisScheduler({ debounceMs: 0, run: runner });
    scheduler.subscribe(input(), () => {});
    await settle();
    strict.equal(scheduler.view.contracts.length, 1);
    await scheduler.close();
  });
  await it("rejects malformed requests and producer results without publishing or retrying authorization failures", async () => {
    strict.throws(() => createLiveAnalysisScheduler({ run: runner, maxActive: 0 }), /limit/u);
    const time = clock();
    let calls = 0;
    const scheduler = createLiveAnalysisScheduler({
      clock: time.api,
      debounceMs: 0,
      maxSubscribers: 1,
      run: async () => {
        calls++;
        return { kind: "made-up" } as unknown as LiveAnalysisOutcome;
      },
    });
    strict.throws(() => scheduler.subscribe(input({ ...fixture(), connectionContext: "bad" }), () => {}), /request/u);
    strict.throws(
      () => scheduler.subscribe(input({ ...fixture(), adapter: { id: "", version: "1" } }), () => {}),
      /identifier/u,
    );
    strict.throws(
      () => scheduler.subscribe({ ...input(), ticket: { ...ticket(), documentVersion: -1 } }, () => {}),
      /version/u,
    );
    strict.throws(
      () => scheduler.advance({ inputGeneration: -1, contextGeneration: 0, policyGeneration: 0 }),
      /generation/u,
    );
    strict.throws(
      () =>
        scheduler.subscribe(
          input({ ...fixture(), candidate: { ...fixture().candidate, sql: "SELECT other" } }),
          () => {},
        ),
      /identity/u,
    );
    const handle = scheduler.subscribe(input(), () => {});
    strict.throws(() => scheduler.subscribe(input(fixture(), "other"), () => {}), /limit/u);
    await settle();
    strict.equal(handle.state.kind, "unavailable");
    time.advance(100000);
    strict.equal(calls, 1);
    strict.equal(scheduler.view.contracts.length, 0);
    scheduler.advance(scheduler.generations);
    await scheduler.close();
    strict.throws(() => scheduler.subscribe(input(), () => {}), /closed/u);
  });
});

await describe("explicit native live runner", async () => {
  await it("acquires, reconciles, closes sessions and classifies unsupported, stale and failed acquisition", async () => {
    strict.equal((await runner(fixture(), new AbortController().signal)).kind, "usable-recorded-context");
    const run = (
      selected: NativeContractAdapter,
      classifyError?: () => { kind: "unavailable"; code: string; retry: "change" },
    ) =>
      createNativeLiveAnalysisRunner({
        adapter: selected,
        contribution: owner,
        ...(classifyError ? { classifyError } : {}),
      })(fixture(), new AbortController().signal);
    strict.equal((await run(adapter({ accept: () => ({ accepted: false, reason: "fixture" }) }))).kind, "partial");
    strict.equal(
      (
        await run(
          adapter({
            open: async () => ({
              context: async () => ({ ...context, databaseContextHash: queryContractDigest("changed") }),
              describe: async () => evidence,
              close: async () => {},
            }),
          }),
        )
      ).kind,
      "stale-context",
    );
    strict.deepEqual(await run(adapter({ id: "different" })), {
      kind: "unavailable",
      code: "native-runner-error",
      retry: "change",
    });
    strict.deepEqual(
      await run(
        adapter({
          open: async () => {
            throw Error("auth");
          },
        }),
        () => ({ kind: "unavailable", code: "authentication", retry: "change" }),
      ),
      { kind: "unavailable", code: "authentication", retry: "change" },
    );
    const controller = new AbortController();
    controller.abort();
    await strict.rejects(() => runner(fixture(), controller.signal));
    const invalid = createNativeLiveAnalysisRunner({
      adapter: adapter(),
      contribution: { ...owner, classify: () => ({ status: "invalid", rule: "fixture", reason: "Invalid" }) },
    });
    strict.equal((await invalid(fixture(), new AbortController().signal)).kind, "conflict");
    const incomplete = createNativeLiveAnalysisRunner({
      adapter: adapter(),
      contribution: {
        ...owner,
        compare: () => ({ status: "unavailable", staticStatus: "known", rule: "fixture", reason: "Not proven" }),
      },
    });
    strict.equal((await incomplete(fixture(), new AbortController().signal)).kind, "partial");
    // Native acquisition remains independently callable by explicit batch hosts.
    strict.equal(
      (await acquireNativeQueryContract({ adapter: adapter(), candidate: fixture().candidate, context })).status,
      "acquired",
    );
  });
});
