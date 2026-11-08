import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { unknownQuerySemantics } from "../../core/src/index.js";
import {
  type AnalysisCache,
  createAnalysisContextScope,
  type LiveAnalysisServices,
  openAnalysisCache,
  prepareLiveContractView,
  queryContractDigest,
} from "../src/index.js";
import { configuration, context, profile, request, result, schema } from "./helpers/host-fixture.js";
import { adapter, evidence, hash, owner } from "./helpers/live-fixture.js";

const plugin = {
  ...profile,
  analyze(sql: string) {
    const range = { start: 0, end: sql.length, line: 1, column: 1 };
    return {
      columns: request.staticClaim.columns.map((column) => ({ ...column, range })),
      parameters: [],
      diagnostics: [],
      resultKind: "rows" as const,
      semantics: unknownQuerySemantics(range, "fixture"),
    };
  },
};
function services(patch: Partial<LiveAnalysisServices> = {}): LiveAnalysisServices {
  return {
    connectionContext: hash,
    adapter: adapter({
      open: async () => ({ context: async () => context, describe: async () => evidence, close: async () => {} }),
    }),
    contribution: owner,
    inspectContext: async () => context,
    close: async () => {},
    ...patch,
  };
}
async function temporary(test: (cache: AnalysisCache) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-live-view-"));
  try {
    await test(await openAnalysisCache({ directory, workspaceContext: hash }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const settings = { ...configuration, mode: "live" as const };
const base = { profile, schema, configuration: settings, candidates: [request.candidate], loadAnalyzer: () => plugin };

await describe("finite explicit live qualification", async () => {
  await it("refreshes classified observation drift only after cleanup and within the existing attempt bound", async () => {
    const { context: _pin, ...automatic } = settings;
    for (const when of ["initial", "final"] as const)
      await temporary(async (cache) => {
        let factories = 0,
          closes = 0;
        const view = await prepareLiveContractView({
          ...base,
          configuration: automatic,
          cache,
          live: {
            adapter() {
              strict.equal(closes, factories, "A fresh observation cannot overtake owned cleanup");
              const attempt = ++factories;
              let reads = 0;
              return services({
                inspectContext: async () => {
                  if (attempt === 1 && ++reads === (when === "initial" ? 1 : 2))
                    throw Error("native guard contradicted");
                  return context;
                },
                classifyError: () => ({ kind: "stale-context", code: "native-guard-drift" }),
                close: async () => {
                  await Promise.resolve();
                  closes++;
                },
              });
            },
          },
        });
        strict.equal(factories, 2);
        strict.equal(closes, 2);
        strict.equal(view.contracts.length, 1);
        await view.assertCurrent();
      });
    for (const boundary of ["pinned", "unavailable", "cleanup", "repeated", "cancelled", "invalid-metadata"] as const)
      await temporary(async (cache) => {
        let factories = 0,
          closes = 0;
        const controller = new AbortController();
        await strict.rejects(
          prepareLiveContractView({
            ...base,
            configuration: boundary === "pinned" ? settings : automatic,
            cache,
            signal: controller.signal,
            live: {
              adapter() {
                factories++;
                return services({
                  inspectContext: async () => {
                    if (boundary === "invalid-metadata") return {} as typeof context;
                    if (boundary === "cancelled") controller.abort(Error("caller cancelled"));
                    throw Error("native guard contradicted");
                  },
                  classifyError: () =>
                    boundary === "unavailable"
                      ? { kind: "unavailable", code: "transport", retry: "transport" }
                      : { kind: "stale-context", code: "guard-drift" },
                  close: async () => {
                    closes++;
                    if (boundary === "cleanup") throw Error("cleanup failed");
                  },
                });
              },
            },
          }),
        );
        strict.equal(factories, boundary === "repeated" ? 3 : 1);
        strict.equal(closes, factories);
      });
  });
  await it("discovers and refreshes observed contexts without a pre-recorded epoch", async () => {
    await temporary(async (cache) => {
      const { context: _context, ...automatic } = settings;
      let observed = context;
      const live = {
        adapter: () =>
          services({
            inspectContext: async () => observed,
            adapter: adapter({
              open: async () => ({
                context: async () => observed,
                describe: async () => evidence,
                close: async () => {},
              }),
            }),
          }),
      };
      const first = await prepareLiveContractView({ ...base, configuration: automatic, cache, live });
      strict.deepEqual(first.context, context);
      await first.assertCurrent();
      observed = { ...context, databaseContextHash: queryContractDigest("new database epoch") };
      const next = await prepareLiveContractView({ ...base, configuration: automatic, cache, live });
      strict.deepEqual(next.context, observed);
      await next.assertCurrent();
      await strict.rejects(first.assertCurrent(), /selection changed/u);
      const scope = createAnalysisContextScope({ ...base, configuration: automatic });
      strict.deepEqual((await cache.lookupContext(scope)).recorded?.context, observed);
      strict.equal((await cache.lookup(request)).cached?.outcome.kind, "stale-context");
      const empty = await prepareLiveContractView({
        ...base,
        configuration: automatic,
        cache,
        live,
        candidates: [],
        loadAnalyzer() {
          throw Error("empty discovery keeps analyzer cold");
        },
      });
      strict.deepEqual(empty.context, observed);
      strict.equal(empty.contracts.length, 0);
    });
  });
  await it("fences a delayed observation that finishes after a newer selection", async () => {
    await temporary(async (cache) => {
      const { context: _context, ...automatic } = settings;
      let resume!: () => void, ready!: () => void;
      const waiting = new Promise<void>((resolve) => {
          resume = resolve;
        }),
        started = new Promise<void>((resolve) => {
          ready = resolve;
        });
      const old = prepareLiveContractView({
        ...base,
        configuration: automatic,
        cache,
        live: {
          adapter: () =>
            services({
              inspectContext: async () => {
                ready();
                await waiting;
                return context;
              },
            }),
        },
      });
      await started;
      const fresh = { ...context, databaseContextHash: queryContractDigest("newer selection") };
      const next = await prepareLiveContractView({
        ...base,
        configuration: automatic,
        cache,
        live: {
          adapter: () =>
            services({
              inspectContext: async () => fresh,
              adapter: adapter({
                open: async () => ({
                  context: async () => fresh,
                  describe: async () => evidence,
                  close: async () => {},
                }),
              }),
            }),
        },
      });
      resume();
      await strict.rejects(old, /selection superseded/u);
      await next.assertCurrent();
      const scope = createAnalysisContextScope({ ...base, configuration: automatic });
      strict.deepEqual((await cache.lookupContext(scope)).recorded?.context, fresh);
    });
  });
  await it("qualifies successful static queries, feeds bounded work and closes resources before returning", async () => {
    await temporary(async (cache) => {
      let active = 0,
        peak = 0,
        descriptions = 0,
        closed = 0,
        inspections = 0;
      const native = services({
        inspectContext: async () => {
          inspections++;
          return context;
        },
        close: async () => {
          closed++;
        },
        adapter: adapter({
          open: async () => {
            active++;
            peak = Math.max(peak, active);
            return {
              context: async () => context,
              describe: async () => {
                descriptions++;
                await new Promise((resolve) => setTimeout(resolve, 1));
                return evidence;
              },
              close: async () => {
                active--;
              },
            };
          },
        }),
      });
      const candidates = Array.from({ length: 35 }, (_, i) => ({
        sql: `SELECT ${i} AS value`,
        parameterOccurrences: [],
      }));
      const view = await prepareLiveContractView({
        ...base,
        cache,
        candidates: [...candidates, candidates[0]!],
        live: { adapter: () => native, maxActive: 3, concurrencyPerContext: 1 },
      });
      strict.equal(descriptions, 35);
      strict.equal(peak, 1);
      strict.equal(active, 0);
      strict.equal(closed, 1);
      strict.equal(inspections, 2);
      strict.equal(view.contracts.length, 35);
      strict.ok(Object.isFrozen(view));
      strict.ok(Object.isFrozen(view.outcomes));
      strict.deepEqual(view.dialect.analyze(candidates[0]!.sql, schema).diagnostics, []);
      strict.equal(view.dialect.analyze("SELECT unprepared()", schema).diagnostics[0]?.code, "TSQ406");
      const again = await prepareLiveContractView({
        ...base,
        cache,
        candidates: [candidates[0]!],
        live: { adapter: () => native },
      });
      strict.equal(
        descriptions,
        36,
        "Explicit live checking cannot substitute recorded evidence for fresh acquisition",
      );
      strict.equal(again.contracts.length, 1);
    });
  });
  await it("reports conflicts and outages without optimistic live fallback", async () => {
    await temporary(async (cache) => {
      await cache.publish({ token: (await cache.lookup(request)).token, request, outcome: result });
      const outage = await prepareLiveContractView({
        ...base,
        cache,
        live: {
          adapter: () =>
            services({
              adapter: adapter({
                open: async () => {
                  throw Error("transport down");
                },
              }),
              classifyError: () => ({ kind: "unavailable", code: "transport-down", retry: "transport" }),
            }),
        },
      });
      strict.match(outage.dialect.analyze(request.candidate.sql, schema).diagnostics[0]!.message, /transport-down/u);
      strict.equal((await cache.lookup(request)).cached?.outcome.kind, "usable-recorded-context");
      const conflict = await prepareLiveContractView({
        ...base,
        cache,
        live: {
          adapter: () =>
            services({
              contribution: {
                ...owner,
                compare: () => ({
                  status: "conflict",
                  staticStatus: "known",
                  rule: "fixture-conflict",
                  reason: "Independent facts disagree",
                }),
              },
            }),
        },
      });
      strict.equal(conflict.contracts.length, 0);
      strict.match(conflict.dialect.analyze(request.candidate.sql, schema).diagnostics[0]!.message, /conflict/u);
      strict.equal((await cache.lookup(request)).cached?.outcome.kind, "conflict");
    });
  });
  await it("retires mismatching contexts before or after acquisition and always closes services", async () => {
    await temporary(async (cache) => {
      for (const changeAfter of [0, 1]) {
        let inspected = 0,
          closed = 0;
        await strict.rejects(
          prepareLiveContractView({
            ...base,
            cache,
            live: {
              adapter: () =>
                services({
                  inspectContext: async () =>
                    inspected++ === changeAfter
                      ? { ...context, databaseContextHash: queryContractDigest("changed") }
                      : context,
                  close: async () => {
                    closed++;
                  },
                }),
            },
          }),
          /context differs/u,
        );
        strict.equal(closed, 1);
        strict.equal((await cache.lookup(request)).cached?.outcome.kind, "stale-context");
      }
    });
  });
  await it("refreshes an automatically observed context after drift only after owned cleanup", async () => {
    await temporary(async (cache) => {
      const { context: _pin, ...automatic } = settings;
      const changed = { ...context, databaseContextHash: queryContractDigest("stable replacement epoch") };
      const candidate = { ...request.candidate };
      let closedSessions = 0;
      let constructed = 0,
        closed = 0,
        described = 0;
      const view = await prepareLiveContractView({
        ...base,
        configuration: automatic,
        cache,
        candidates: [candidate],
        live: {
          adapter: () => {
            strict.equal(constructed, closed, "A new attempt must wait for the previous services to close");
            strict.equal(constructed, closedSessions);
            const attempt = ++constructed;
            let reads = 0;
            return services({
              inspectContext: async () => (attempt === 1 ? context : changed),
              adapter: adapter({
                open: async () => ({
                  context: async () => (attempt === 1 && reads++ === 0 ? context : changed),
                  describe: async (captured) => {
                    strict.equal(captured.sql, request.candidate.sql);
                    described++;
                    return evidence;
                  },
                  close: async () => {
                    closedSessions++;
                  },
                }),
              }),
              close: async () => {
                candidate.sql = "SELECT changed_after_capture()";
                await Promise.resolve();
                closed++;
              },
            });
          },
        },
      });
      strict.equal(constructed, 2);
      strict.equal(closed, 2);
      strict.equal(described, 2);
      strict.deepEqual(view.context, changed);
      strict.equal(view.contracts.length, 1);
      await view.assertCurrent();
      strict.equal((await cache.lookup(request)).cached?.outcome.kind, "stale-context");
    });
  });
  await it("bounds repeated automatic drift and never retries a cleanup failure", async () => {
    await temporary(async (cache) => {
      const { context: _pin, ...automatic } = settings;
      const changed = { ...context, databaseContextHash: queryContractDigest("unstable epoch") };
      for (const cleanupFails of [false, true]) {
        let constructed = 0,
          closed = 0;
        await strict.rejects(
          prepareLiveContractView({
            ...base,
            configuration: automatic,
            cache,
            live: {
              adapter: () => {
                constructed++;
                return services({
                  adapter: adapter({
                    open: async () => ({
                      context: async () => changed,
                      describe: async () => evidence,
                      close: async () => {},
                    }),
                  }),
                  close: async () => {
                    closed++;
                    if (cleanupFails) throw Error("cleanup failed");
                  },
                });
              },
            },
          }),
          cleanupFails ? AggregateError : /context changed/u,
        );
        strict.equal(constructed, cleanupFails ? 1 : 3);
        strict.equal(closed, constructed);
        strict.equal((await cache.lookup(request)).cached?.outcome.kind, "stale-context");
      }
    });
  });
  await it("does not retry caller cancellation during an automatic refresh", async () => {
    await temporary(async (cache) => {
      const { context: _pin, ...automatic } = settings;
      const controller = new AbortController();
      let constructed = 0,
        closed = 0;
      await strict.rejects(
        prepareLiveContractView({
          ...base,
          configuration: automatic,
          cache,
          signal: controller.signal,
          live: {
            adapter: () => {
              const attempt = ++constructed;
              if (attempt === 2) controller.abort(new Error("cancel automatic refresh"));
              return services({
                adapter: adapter({
                  open: async () => ({
                    context: async () => ({
                      ...context,
                      databaseContextHash: queryContractDigest("drift before refresh"),
                    }),
                    describe: async () => evidence,
                    close: async () => {},
                  }),
                }),
                close: async () => {
                  closed++;
                },
              });
            },
          },
        }),
        /cancel automatic refresh/u,
      );
      strict.equal(constructed, 2);
      strict.equal(closed, 2);
    });
  });
  await it("does not publish a returned view after cancellation during cleanup", async () => {
    await temporary(async (cache) => {
      const { context: _pin, ...automatic } = settings;
      for (const configuration of [settings, automatic]) {
        const controller = new AbortController();
        let closed = 0;
        await strict.rejects(
          prepareLiveContractView({
            ...base,
            configuration,
            cache,
            signal: controller.signal,
            live: {
              adapter: () =>
                services({
                  close: async () => {
                    closed++;
                    controller.abort(new Error("cancel during cleanup"));
                  },
                }),
            },
          }),
          /cancel during cleanup/u,
        );
        strict.equal(closed, 1);
      }
    });
  });
  await it("handles context drift reported by a query and returns no stale batch view", async () => {
    await temporary(async (cache) => {
      await strict.rejects(
        prepareLiveContractView({
          ...base,
          cache,
          live: {
            adapter: () =>
              services({
                adapter: adapter({
                  open: async () => ({
                    context: async () => ({ ...context, databaseContextHash: queryContractDigest("changed") }),
                    describe: async () => evidence,
                    close: async () => {},
                  }),
                }),
              }),
          },
        }),
        /context changed/u,
      );
      strict.equal((await cache.lookup(request)).cached?.outcome.kind, "stale-context");
    });
  });
  await it("bounds native deadlines and batch cancellation while draining owned work", async () => {
    await temporary(async (cache) => {
      let closed = 0;
      const hanging = () =>
        services({
          close: async () => {
            closed++;
          },
          adapter: adapter({
            open: async () => ({
              context: async () => context,
              close: async () => {},
              describe: async (_candidate, signal) =>
                new Promise((_resolve, reject) => {
                  signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
                }),
            }),
          }),
        });
      const deadline = await prepareLiveContractView({ ...base, cache, live: { adapter: hanging, deadlineMs: 5 } });
      strict.match(deadline.dialect.analyze(request.candidate.sql, schema).diagnostics[0]!.message, /native-deadline/u);
      strict.equal(closed, 1);
      await strict.rejects(
        prepareLiveContractView({ ...base, cache, live: { adapter: hanging, batchDeadlineMs: 5 } }),
        /batch deadline/u,
      );
      strict.equal(closed, 2);
      const control = new AbortController();
      const external = prepareLiveContractView({
        ...base,
        cache,
        signal: control.signal,
        live: {
          adapter: async () => {
            control.abort(new Error("external cancellation"));
            return services({
              close: async () => {
                closed++;
              },
            });
          },
        },
      });
      await strict.rejects(external, /external cancellation/u);
      strict.equal(closed, 3);
      await strict.rejects(
        prepareLiveContractView({ ...base, cache, signal: control.signal, live: { adapter: hanging } }),
        /external cancellation/u,
      );
    });
  });
  await it("keeps empty projects cold and rejects incompatible profiles, owners and service registrations", async () => {
    await temporary(async (cache) => {
      const empty = await prepareLiveContractView({
        ...base,
        cache,
        candidates: [],
        loadAnalyzer: () => {
          throw Error("cold");
        },
        live: {
          adapter: () => {
            throw Error("cold");
          },
        },
      });
      strict.equal(empty.outcomes.length, 0);
      for (const patch of [
        { configuration: { ...configuration } },
        { profile: plugin },
        { profile: { ...profile, grammarVersion: "2" } },
        { schema: { ...schema, version: "changed" } },
        { typePolicy: { changed: true } },
        { loadAnalyzer: () => ({ ...plugin, grammarVersion: "2" }) },
        { candidates: Array.from({ length: 4097 }, () => request.candidate) },
        { candidates: Array.from({ length: 17 }, () => ({ sql: "x".repeat(1024 * 1024), parameterOccurrences: [] })) },
      ])
        await strict.rejects(
          prepareLiveContractView({ ...base, cache, live: { adapter: () => services() }, ...patch }),
        );
      for (const patch of [
        { connectionContext: queryContractDigest("wrong") },
        { adapter: { ...services().adapter, version: "2" } },
        { contribution: { ...owner, version: "2" } },
        { inspectContext: undefined },
      ]) {
        let closed = 0;
        await strict.rejects(
          prepareLiveContractView({
            ...base,
            cache,
            live: {
              adapter: () =>
                ({
                  ...services(),
                  ...patch,
                  close: async () => {
                    closed++;
                  },
                }) as LiveAnalysisServices,
            },
          }),
          /registration differs/u,
        );
        strict.equal(closed, 1);
      }
      await strict.rejects(
        prepareLiveContractView({
          ...base,
          cache,
          live: { adapter: () => ({ ...services(), close: undefined }) as unknown as LiveAnalysisServices },
        }),
        /owned cleanup/u,
      );
      for (const inspectContext of [
        async () => context,
        async () => {
          throw Error("inspection failed");
        },
      ])
        await strict.rejects(
          prepareLiveContractView({
            ...base,
            cache,
            live: {
              adapter: () =>
                services({
                  inspectContext,
                  close: async () => {
                    throw Error("cleanup failed");
                  },
                }),
            },
          }),
          AggregateError,
        );
    });
  });
});
