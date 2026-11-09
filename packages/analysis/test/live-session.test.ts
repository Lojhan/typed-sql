import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { unknownQuerySemantics } from "../../core/src/index.js";
import {
  createLiveContractSession,
  LiveContextUnavailableError,
  openAnalysisCache,
  queryContractDigest,
} from "../src/index.js";
import { configuration, context, profile, request, schema } from "./helpers/host-fixture.js";
import { adapter, evidence, owner } from "./helpers/live-fixture.js";

const range = { start: 0, end: 17, line: 1, column: 1 };
const analyzer = {
  ...profile,
  analyze() {
    return {
      columns: [
        {
          name: "value",
          tsType: "number",
          runtimeType: "number" as const,
          databaseType: "integer",
          nullable: false,
          range,
        },
      ],
      parameters: [],
      diagnostics: [],
      semantics: unknownQuerySemantics(range, "fixture"),
      resultKind: "rows" as const,
    };
  },
};
await describe("project live session", async () => {
  await it("shares its transport, context observations and qualified work across requests, then detects context drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-live-session-"));
    let time = 0,
      factories = 0,
      observations = 0,
      descriptions = 0,
      closes = 0,
      changes = 0;
    let selected = context;
    const cache = await openAnalysisCache({ directory, workspaceContext: queryContractDigest("session") });
    const { context: _context, ...automatic } = configuration;
    const session = createLiveContractSession({
      profile,
      schema,
      configuration: { ...automatic, mode: "live" },
      cache,
      loadAnalyzer: () => analyzer,
      now: () => time,
      onContextChange: () => changes++,
      live: {
        adapter: () => {
          factories++;
          return {
            connectionContext: configuration.cache.connectionContext,
            adapter: adapter({
              open: async () => ({
                context: async () => selected,
                describe: async () => {
                  descriptions++;
                  return evidence;
                },
                close: async () => {},
              }),
            }),
            contribution: owner,
            inspectContext: async () => {
              observations++;
              return selected;
            },
            close: async () => {
              closes++;
            },
          };
        },
      },
    });
    try {
      const first = await session.prepare({ document: "file:///one.ts", version: 1, candidates: [request.candidate] });
      strict.equal(first.contracts.length, 1);
      const second = await session.prepare({ document: "file:///two.ts", version: 1, candidates: [request.candidate] });
      strict.equal(second.contracts.length, 1);
      strict.equal(factories, 1);
      strict.equal(observations, 1);
      strict.equal(descriptions, 1);
      await first.assertCurrent();
      time = 5001;
      await session.prepare({ document: "file:///two.ts", version: 1, candidates: [request.candidate] });
      strict.equal(observations, 2);
      strict.equal(descriptions, 1);
      await first.assertCurrent();
      time = 10002;
      selected = { ...context, databaseContextHash: queryContractDigest("changed") };
      const refreshed = await session.prepare({
        document: "file:///two.ts",
        version: 1,
        candidates: [request.candidate],
      });
      strict.equal(refreshed.context.databaseContextHash, selected.databaseContextHash);
      strict.equal(observations, 3);
      strict.equal(descriptions, 2);
      strict.equal(changes, 1);
      await strict.rejects(first.assertCurrent());
      session.closeDocument("file:///two.ts");
      await strict.rejects(refreshed.assertCurrent());
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
    strict.equal(closes, 1);
    await session.close();
    strict.equal(closes, 1);
    await strict.rejects(session.prepare({ document: "file:///one.ts", version: 2, candidates: [] }));
  });
  await it("recaptures context after cache invalidation even within the observation interval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-session-fence-"));
    const cache = await openAnalysisCache({ directory, workspaceContext: queryContractDigest("session-fence") });
    const { context: _context, ...automatic } = configuration;
    let observations = 0;
    const session = createLiveContractSession({
      profile,
      schema,
      configuration: { ...automatic, mode: "live" },
      cache,
      loadAnalyzer: () => analyzer,
      now: () => 0,
      live: {
        adapter: () => ({
          connectionContext: configuration.cache.connectionContext,
          adapter: adapter({
            open: async () => ({ context: async () => context, describe: async () => evidence, close: async () => {} }),
          }),
          contribution: owner,
          inspectContext: async () => {
            observations++;
            return context;
          },
          close: async () => {},
        }),
      },
    });
    try {
      const first = await session.prepare({ document: "file:///one.ts", version: 1, candidates: [request.candidate] });
      await first.assertCurrent();
      strict.equal(observations, 1);
      await cache.invalidate();
      await strict.rejects(first.assertCurrent());
      const fresh = await session.prepare({ document: "file:///one.ts", version: 1, candidates: [request.candidate] });
      await fresh.assertCurrent();
      strict.equal(observations, 2, "A fresh native observation is required after a changed cache fence");
      strict.equal(fresh.contracts.length, 1);
      await strict.rejects(first.assertCurrent(), "A fresh view must not revive the old view's token");
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("retries classified acquisition drift with fresh observations, bounded attempts and retained explicit pins", async () => {
    for (const [pinned, races] of [
      [false, 1],
      [false, 3],
      [true, 1],
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), "typed-sql-session-acquisition-race-"));
      const cache = await openAnalysisCache({ directory, workspaceContext: queryContractDigest("acquisition-race") });
      const { context: _context, ...automatic } = configuration;
      const guard = new Error("classified acquisition guard race");
      let observations = 0,
        descriptions = 0,
        closes = 0;
      const session = createLiveContractSession({
        profile,
        schema,
        cache,
        loadAnalyzer: () => analyzer,
        configuration: { ...(pinned ? configuration : automatic), mode: "live" },
        live: {
          adapter: () => ({
            connectionContext: configuration.cache.connectionContext,
            contribution: owner,
            adapter: adapter({
              classifyError: () => ({ kind: "stale-context", code: "acquisition-guard" }),
              open: async () => ({
                context: async () => context,
                describe: async () => {
                  if (++descriptions <= races) throw guard;
                  return evidence;
                },
                close: async () => {
                  closes++;
                },
              }),
            }),
            inspectContext: async () => {
              observations++;
              return context;
            },
            close: async () => {},
          }),
        },
      });
      try {
        const prepared = session.prepare({ document: "file:///one.ts", version: 1, candidates: [request.candidate] });
        if (pinned || races === 3) await strict.rejects(prepared);
        else {
          const fresh = await prepared;
          await fresh.assertCurrent();
          strict.equal(fresh.contracts.length, 1);
        }
        const attempts = pinned ? 1 : races === 3 ? 3 : 2;
        strict.equal(descriptions, attempts);
        strict.equal(observations, attempts, "Each new acquisition attempt requires a fresh context observation");
        strict.equal(closes, attempts, "Every failed acquisition lease must close before retrying");
      } finally {
        await session.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  await it("recaptures classified observation races without restoring retired evidence or retrying permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-session-observation-race-"));
    const cache = await openAnalysisCache({ directory, workspaceContext: queryContractDigest("observation-race") });
    const { context: _context, ...automatic } = configuration;
    const guard = new Error("classified native guard race");
    const permission = new Error("metadata permission unavailable");
    let current = context,
      time = 0,
      observations = 0,
      descriptions = 0,
      races = 0,
      denied = false;
    const session = createLiveContractSession({
      profile,
      schema,
      cache,
      configuration: { ...automatic, mode: "live" },
      loadAnalyzer: () => analyzer,
      now: () => time,
      live: {
        adapter: () => ({
          connectionContext: configuration.cache.connectionContext,
          contribution: owner,
          adapter: adapter({
            open: async () => ({
              context: async () => current,
              describe: async () => {
                descriptions++;
                return evidence;
              },
              close: async () => {},
            }),
          }),
          inspectContext: async () => {
            observations++;
            if (races > 0) {
              races--;
              throw guard;
            }
            if (denied) throw permission;
            return current;
          },
          classifyError: (error) =>
            error === guard
              ? { kind: "stale-context", code: "guard-raced" }
              : { kind: "unavailable", code: "permission-unavailable", retry: "change" },
          close: async () => {},
        }),
      },
    });
    try {
      const before = await session.prepare({
        document: "file:///race.ts",
        version: 1,
        candidates: [request.candidate],
      });
      strict.equal(before.contracts.length, 1);
      const initialObservations = observations;
      time = 5001;
      current = { ...context, databaseContextHash: queryContractDigest("after guarded DDL") };
      races = 1;
      const fresh = await session.prepare({ document: "file:///race.ts", version: 2, candidates: [request.candidate] });
      strict.equal(fresh.context.databaseContextHash, current.databaseContextHash);
      strict.equal(observations - initialObservations, 2);
      strict.equal(descriptions, 2, "The new context requires fresh query evidence");
      await strict.rejects(before.assertCurrent());
      const beforeBound = observations;
      time = 10002;
      races = 3;
      await strict.rejects(
        session.prepare({ document: "file:///race.ts", version: 3, candidates: [request.candidate] }),
        (error: unknown) => error === guard,
      );
      strict.equal(observations - beforeBound, 3);
      strict.equal(descriptions, 2);
      denied = true;
      const beforePermission = observations;
      await strict.rejects(
        session.prepare({ document: "file:///race.ts", version: 4, candidates: [request.candidate] }),
        LiveContextUnavailableError,
      );
      strict.equal(observations - beforePermission, 1, "Permission failures are not observation races");
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("shares in-flight work without letting one cancelled subscriber cancel another", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-session-cancel-"));
    const cache = await openAnalysisCache({ directory, workspaceContext: queryContractDigest("shared") });
    let started!: () => void,
      finish!: () => void,
      descriptions = 0;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = createLiveContractSession({
      profile,
      schema,
      configuration: { ...configuration, mode: "live" },
      cache,
      loadAnalyzer: () => analyzer,
      live: {
        adapter: () => ({
          connectionContext: configuration.cache.connectionContext,
          contribution: owner,
          inspectContext: async () => context,
          close: async () => {},
          adapter: adapter({
            open: async () => ({
              context: async () => context,
              describe: async () => {
                descriptions++;
                started();
                await release;
                return evidence;
              },
              close: async () => {},
            }),
          }),
        }),
      },
    });
    try {
      const controller = new AbortController();
      const first = session.prepare({
        document: "file:///first.ts",
        version: 1,
        candidates: [request.candidate],
        signal: controller.signal,
      });
      const firstOutcome = first.then(
        () => "unexpected",
        () => "cancelled",
      );
      const second = session.prepare({ document: "file:///second.ts", version: 1, candidates: [request.candidate] });
      await entered;
      controller.abort();
      strict.equal(await firstOutcome, "cancelled");
      finish();
      strict.equal((await second).contracts.length, 1);
      strict.equal(descriptions, 1);
      strict.equal(session.status().activePreparations, 0);
    } finally {
      finish();
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("times out a noncooperative factory and disposes its eventual resources once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-session-factory-"));
    const cache = await openAnalysisCache({ directory, workspaceContext: queryContractDigest("factory") });
    let release!: () => void,
      closes = 0;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = createLiveContractSession({
      profile,
      schema,
      configuration: { ...configuration, mode: "live" },
      cache,
      loadAnalyzer: () => analyzer,
      live: {
        deadlineMs: 10,
        adapter: async () => {
          await ready;
          return {
            connectionContext: configuration.cache.connectionContext,
            adapter: adapter(),
            contribution: owner,
            inspectContext: async () => context,
            close: async () => {
              closes++;
            },
          };
        },
      },
    });
    const result = session
      .prepare({ document: "file:///factory.ts", version: 1, candidates: [request.candidate] })
      .then(
        () => false,
        () => true,
      );
    await new Promise((resolve) => setTimeout(resolve, 20));
    strict.equal(await result, true);
    const closing = session.close();
    release();
    await closing;
    strict.equal(closes, 1);
    await rm(directory, { recursive: true, force: true });
  });
  await it("coalesces unavailable context attempts and separates transport retry from configuration retry", async () => {
    for (const retry of ["transport", "change"] as const) {
      const directory = await mkdtemp(join(tmpdir(), "typed-sql-session-outage-"));
      const cache = await openAnalysisCache({ directory, workspaceContext: queryContractDigest(retry) });
      let time = 0,
        calls = 0,
        online = false;
      const session = createLiveContractSession({
        profile,
        schema,
        configuration: { ...configuration, mode: "live" },
        cache,
        loadAnalyzer: () => analyzer,
        now: () => time,
        live: {
          adapter: () => ({
            connectionContext: configuration.cache.connectionContext,
            adapter: adapter({
              open: async () => ({
                context: async () => context,
                describe: async () => evidence,
                close: async () => {},
              }),
            }),
            contribution: owner,
            inspectContext: async () => {
              calls++;
              if (!online) throw Error("secret driver detail");
              return context;
            },
            classifyError: () => ({ kind: "unavailable", code: "fixture-availability", retry }),
            close: async () => {},
          }),
        },
      });
      const prepare = () =>
        session.prepare({ document: "file:///availability.ts", version: 1, candidates: [request.candidate] });
      try {
        await strict.rejects(
          prepare(),
          (error: unknown) => error instanceof LiveContextUnavailableError && !error.message.includes("secret"),
        );
        time = 4999;
        await strict.rejects(prepare(), LiveContextUnavailableError);
        strict.equal(calls, 1);
        time = 5001;
        online = true;
        if (retry === "transport") strict.equal((await prepare()).contracts.length, 1);
        else await strict.rejects(prepare(), LiveContextUnavailableError);
        strict.equal(calls, retry === "transport" ? 2 : 1);
      } finally {
        await session.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  await it("bounds a noncooperative context read and discards its late result after close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-session-context-"));
    const cache = await openAnalysisCache({ directory, workspaceContext: queryContractDigest("context-timeout") });
    let release!: (value: typeof context) => void,
      calls = 0;
    const reading = new Promise<typeof context>((resolve) => {
      release = resolve;
    });
    const session = createLiveContractSession({
      profile,
      schema,
      configuration: { ...configuration, mode: "live" },
      cache,
      loadAnalyzer: () => analyzer,
      live: {
        deadlineMs: 10,
        adapter: () => ({
          connectionContext: configuration.cache.connectionContext,
          adapter: adapter(),
          contribution: owner,
          inspectContext: async () => {
            calls++;
            return reading;
          },
          close: async () => {
            release(context);
          },
        }),
      },
    });
    const pending = session
      .prepare({ document: "file:///timeout.ts", version: 1, candidates: [request.candidate] })
      .then(
        () => false,
        (error) => error instanceof LiveContextUnavailableError,
      );
    // No unrelated timer keeps the process alive: the owned context deadline must settle this request.
    strict.equal(await pending, true);
    strict.equal(calls, 1);
    strict.equal(session.status().activePreparations, 0);
    await session.close();
    await rm(directory, { recursive: true, force: true });
  });
});
