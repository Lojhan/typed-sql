import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { unknownQuerySemantics } from "../../core/src/index.js";
import {
  type AnalysisCache,
  createAnalysisContextScope,
  createLiveContractSession,
  createProjectCatalog,
  type LiveAnalysisServices,
  openAnalysisCache,
  type ProjectCatalogContribution,
  prepareLiveContractView,
  prepareOfflineContractView,
  queryContractDigest,
} from "../src/index.js";
import { configuration, context, profile, request, schema } from "./helpers/host-fixture.js";
import { adapter, evidence, hash, owner } from "./helpers/live-fixture.js";

const catalogOwner = { id: "vendor/catalog", version: "1" };
const contribution: ProjectCatalogContribution<typeof schema, Record<string, unknown>> = {
  ...catalogOwner,
  grammar: context.grammar,
  apply(base) {
    return {
      ...base,
      functions: {
        selected: {
          name: "selected",
          argumentTypes: [],
          databaseReturnType: "integer",
          returnType: "number",
          nullable: true,
        },
      },
    };
  },
};
const plugin = {
  ...profile,
  analyze(sql: string, selected: typeof schema) {
    strict.ok("functions" in selected, "Static qualification must use the enriched schema");
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
const { context: _pinned, ...automatic } = configuration;
async function temporary(test: (cache: AnalysisCache) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-live-catalog-"));
  try {
    await test(await openAnalysisCache({ directory, workspaceContext: hash }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function fixture() {
  const counts = { factories: 0, closes: 0, catalogs: 0, describes: 0, sessions: 0, sessionCloses: 0, loaders: 0 };
  let observed = context;
  let onCatalog = () => {},
    onDescribe = () => {};
  const native = adapter({
    projectCatalogOwner: catalogOwner,
    async open() {
      counts.sessions++;
      return {
        context: async () => observed,
        async projectCatalog(sql, before) {
          counts.catalogs++;
          strict.deepEqual(sql, [request.candidate.sql]);
          const catalog = createProjectCatalog({
            context: before,
            owner: catalogOwner,
            entries: [
              {
                kind: "routine",
                identity: "selected()",
                permission: "fixed-result",
                evidenceDigest: hash,
                definition: { nativeResult: "integer" },
              },
            ],
          });
          onCatalog();
          return catalog;
        },
        async describe() {
          counts.describes++;
          onDescribe();
          return evidence;
        },
        async close() {
          counts.sessionCloses++;
        },
      };
    },
  });
  const services = (): LiveAnalysisServices => {
    counts.factories++;
    return {
      connectionContext: hash,
      adapter: native,
      contribution: owner,
      inspectContext: async () => observed,
      close: async () => {
        counts.closes++;
      },
    };
  };
  const base = {
    profile,
    schema,
    configuration: { ...automatic, mode: "live" as const },
    candidates: [request.candidate],
    loadAnalyzer: () => plugin,
    projectCatalogs: {
      capture: true,
      loadContributions() {
        counts.loaders++;
        return [contribution];
      },
    },
    live: { adapter: services },
  };
  return {
    counts,
    base,
    native,
    services,
    set context(value: typeof context) {
      observed = value;
    },
    get context() {
      return observed;
    },
    set onCatalog(value: () => void) {
      onCatalog = value;
    },
    set onDescribe(value: () => void) {
      onDescribe = value;
    },
  };
}
await describe("selected live catalog capture", async () => {
  await it("retries classified initial guard drift after cleanup and keeps a pinned observation blocking", async () => {
    for (const boundary of ["initial", "post-capture", "pinned"] as const)
      await temporary(async (cache) => {
        const pinned = boundary === "pinned";
        const f = fixture();
        let reads = 0;
        const input = {
          ...f.base,
          cache,
          configuration: pinned ? { ...f.base.configuration, context } : f.base.configuration,
          live: {
            adapter() {
              strict.equal(f.counts.factories, f.counts.closes);
              const owned = f.services();
              return {
                ...owned,
                inspectContext: async (signal: AbortSignal) => {
                  if (f.counts.factories === 1 && ++reads === (boundary === "post-capture" ? 2 : 1))
                    throw Error("guard changed");
                  return owned.inspectContext(signal);
                },
                classifyError: () => ({ kind: "stale-context" as const, code: "native-context-drift" }),
              };
            },
          },
        };
        if (pinned) await strict.rejects(prepareLiveContractView(input), /context changed/u);
        else {
          const view = await prepareLiveContractView(input);
          strict.equal(view.contracts.length, 1);
          await view.assertCurrent();
        }
        strict.equal(f.counts.factories, pinned ? 1 : 2);
        strict.equal(f.counts.closes, f.counts.factories);
      });
  });
  await it("retries classified collection guard failures after cleanup, keeping pinned and cleanup failures blocking", async () => {
    for (const mode of ["automatic", "pinned", "cleanup", "unclassified"] as const)
      await temporary(async (cache) => {
        const f = fixture();
        const guard = Error("collection guard drift");
        const input = {
          ...f.base,
          cache,
          configuration: mode === "pinned" ? { ...f.base.configuration, context } : f.base.configuration,
          live: {
            adapter() {
              strict.equal(f.counts.factories, f.counts.closes);
              const owned = f.services();
              return {
                ...owned,
                adapter: {
                  ...owned.adapter,
                  classifyError: () =>
                    mode === "unclassified"
                      ? { kind: "unavailable" as const, code: "fixture-collection", retry: "change" as const }
                      : { kind: "stale-context" as const, code: "fixture-guard" },
                  async open(signal?: AbortSignal) {
                    const session = await owned.adapter.open(signal);
                    return {
                      ...session,
                      async projectCatalog(...args: Parameters<NonNullable<typeof session.projectCatalog>>) {
                        if (f.counts.factories === 1) throw guard;
                        return session.projectCatalog!(...args);
                      },
                      async close() {
                        await session.close();
                        if (mode === "cleanup") throw Error("fixture cleanup failure");
                      },
                    };
                  },
                },
              };
            },
          },
        };
        if (mode === "automatic") {
          const view = await prepareLiveContractView(input);
          strict.equal(view.contracts.length, 1);
          await view.assertCurrent();
          strict.equal(f.counts.factories, 2);
        } else {
          await strict.rejects(
            prepareLiveContractView(input),
            mode === "cleanup"
              ? /acquisition and cleanup failed/u
              : mode === "pinned"
                ? /Database context changed/u
                : /collection guard drift/u,
          );
          strict.equal(f.counts.factories, 1);
        }
        strict.equal(f.counts.factories, f.counts.closes);
        strict.equal(f.counts.sessions, f.counts.sessionCloses);
      });
  });
  await it("recaptures retired base evidence before publication and bounds repeated retirement", async () => {
    for (const mode of ["once", "persistent", "pinned"] as const)
      await temporary(async (cache) => {
        const f = fixture();
        const input = {
          ...f.base,
          configuration: mode === "pinned" ? { ...f.base.configuration, context } : f.base.configuration,
        };
        let invalidations = 0;
        const observed = {
          ...cache,
          async areTokensCurrent(tokens: Parameters<AnalysisCache["areTokensCurrent"]>[0]) {
            // Retire actual cache evidence after qualification, before closure publication.
            if (mode === "persistent" || invalidations === 0) {
              invalidations++;
              await cache.invalidate();
            }
            return cache.areTokensCurrent(tokens);
          },
        };
        if (mode !== "once") {
          await strict.rejects(prepareLiveContractView({ ...input, cache: observed }), /Base catalog context changed/u);
          strict.equal(f.counts.factories, mode === "pinned" ? 1 : 3);
          strict.equal(invalidations, mode === "pinned" ? 1 : 3);
        } else {
          const view = await prepareLiveContractView({ ...input, cache: observed });
          strict.equal(view.contracts.length, 1);
          strict.equal(f.counts.factories, 2);
          await view.assertCurrent();
        }
        strict.equal(f.counts.closes, f.counts.factories);
        strict.equal(f.counts.sessions, f.counts.sessionCloses);
      });
  });
  await it("preserves contributed services and adapter members inherited from prototypes", async () =>
    temporary(async (cache) => {
      const f = fixture();
      const native = Object.create(f.native) as typeof f.native;
      native.classifyError = function () {
        strict.equal(this, native);
        return { kind: "unavailable", code: "fixture-transport", retry: "transport" };
      };
      const services = Object.create(f.services()) as LiveAnalysisServices;
      Object.defineProperty(services, "adapter", { value: native });
      Object.defineProperty(services, "classifyError", {
        value: function (this: LiveAnalysisServices) {
          strict.equal(this, services);
          return { kind: "unavailable", code: "fixture-transport", retry: "transport" };
        },
      });
      const result = await prepareLiveContractView({ ...f.base, cache, live: { adapter: () => services } });
      strict.equal(result.contracts.length, 1);
      strict.equal(f.counts.closes, 1);
    }));
  await it("keeps base/native identity independent while qualifying and caching enriched claims", async () =>
    temporary(async (cache) => {
      const f = fixture();
      const first = await prepareLiveContractView({ ...f.base, cache });
      strict.notEqual(first.context.profileHash, context.profileHash);
      strict.notEqual(first.context.schemaHash, context.schemaHash);
      strict.deepEqual(first.projectCatalogs?.baseContext, context);
      strict.equal(first.contracts.length, 1);
      strict.deepEqual(first.dialect.analyze(request.candidate.sql, first.schema).diagnostics, []);
      strict.ok(first.dialect.analyze(request.candidate.sql, schema).diagnostics.length);
      const scope = createAnalysisContextScope(f.base);
      strict.deepEqual((await cache.lookupContext(scope)).recorded?.context, context);
      await first.assertCurrent();
      const again = await prepareLiveContractView({
        ...f.base,
        cache,
        recordedProjectCatalogs: first.projectCatalogs!,
      });
      strict.deepEqual(again.context, first.context);
      await strict.rejects(first.assertCurrent(), /changed/u);
      await again.assertCurrent();
      strict.equal(f.counts.describes, 2, "Explicit live qualification independently refreshes matching evidence");
      strict.equal(f.counts.closes, 2);
      strict.equal(f.counts.sessions, f.counts.sessionCloses);
      f.context = { ...context, databaseContextHash: queryContractDigest("changed epoch") };
      const changed = await prepareLiveContractView({
        ...f.base,
        cache,
        recordedProjectCatalogs: first.projectCatalogs!,
      });
      strict.notEqual(changed.context.profileHash, first.context.profileHash);
      await strict.rejects(again.assertCurrent(), /changed/u);
      await changed.assertCurrent();
    }));
  await it("releases old owners before retrying catalog or query context drift", async () => {
    for (const stage of ["catalog", "describe"] as const)
      await temporary(async (cache) => {
        const f = fixture();
        const drift = () => {
          f.context = { ...context, databaseContextHash: queryContractDigest("drift") };
          f.onCatalog = () => {};
          f.onDescribe = () => {};
        };
        if (stage === "catalog") f.onCatalog = drift;
        else f.onDescribe = drift;
        const result = await prepareLiveContractView({ ...f.base, cache });
        strict.equal(result.context.databaseContextHash, f.context.databaseContextHash);
        strict.equal(f.counts.factories, 2);
        strict.equal(f.counts.closes, 2);
        strict.equal(f.counts.sessions, f.counts.sessionCloses);
      });
  });
  await it("uses independent offline rules for hybrid adapter exclusions without fabricating native qualification", async () =>
    temporary(async (cache) => {
      const f = fixture();
      const live = {
        adapter: () => ({
          ...f.services(),
          adapter: { ...f.native, accept: () => ({ accepted: false as const, reason: "fixture-scope" }) },
        }),
      };
      const hybrid = await prepareLiveContractView({
        ...f.base,
        cache,
        live,
        configuration: { ...f.base.configuration, qualification: { ...configuration.qualification, mode: "hybrid" } },
      });
      strict.equal(hybrid.contracts.length, 0);
      strict.equal(hybrid.outcomes[0]!.outcome.kind, "partial");
      strict.deepEqual(hybrid.dialect.analyze(request.candidate.sql, hybrid.schema).diagnostics, []);
      strict.ok(
        hybrid.dialect.analyze(request.candidate.sql, schema).diagnostics.some((item) => item.severity === "error"),
      );
      strict.ok(
        hybrid.dialect
          .analyze(request.candidate.sql, hybrid.schema, { changed: true })
          .diagnostics.some((item) => item.severity === "error"),
      );
      const required = await prepareLiveContractView({ ...f.base, cache, live });
      strict.equal(required.contracts.length, 0);
      strict.ok(
        required.dialect
          .analyze(request.candidate.sql, required.schema)
          .diagnostics.some((item) => item.severity === "error"),
      );
      strict.equal(f.counts.describes, 0);
    }));
  await it("keeps unsupported capture, mismatched services and pinned drift blocking", async () =>
    temporary(async (cache) => {
      const f = fixture();
      await strict.rejects(
        prepareLiveContractView({
          ...f.base,
          cache,
          live: { adapter: () => ({ ...f.services(), connectionContext: queryContractDigest("wrong target") }) },
        }),
        /registered target/u,
      );
      strict.equal(f.counts.catalogs, 0);
      await strict.rejects(
        prepareLiveContractView({
          ...f.base,
          cache,
          live: { adapter: () => ({ ...f.services(), adapter: adapter() }) },
        }),
        /unsupported-adapter/u,
      );
      strict.equal(f.counts.loaders, 0);
      f.context = { ...context, databaseContextHash: queryContractDigest("pinned drift") };
      await strict.rejects(
        prepareLiveContractView({ ...f.base, cache, configuration: { ...f.base.configuration, context } }),
        /Pinned catalog context/u,
      );
      strict.equal(f.counts.factories, f.counts.closes);
    }));
  await it("persists session captures, reuses unchanged document views, and refreshes on interval or drift", async () =>
    temporary(async (cache) => {
      const f = fixture();
      let now = 100;
      const session = createLiveContractSession({ ...f.base, cache, now: () => now, contextIntervalMs: 100 });
      const document = { document: "file:///query.ts", version: 1, candidates: f.base.candidates };
      try {
        const first = await session.prepare(document);
        strict.equal(first.contracts.length, 1);
        const scope = createAnalysisContextScope(f.base);
        strict.deepEqual(
          (await cache.lookupProjectCatalog({ scope, sql: f.base.candidates.map(({ sql }) => sql) })).cached?.closure,
          first.projectCatalogs,
        );
        await (await session.prepare(document)).assertCurrent();
        strict.equal(f.counts.catalogs, 1);
        strict.equal(f.counts.factories, 1);
        strict.equal(f.counts.closes, 0);
        now += 101;
        const refreshed = await session.prepare(document);
        strict.equal(f.counts.catalogs, 2);
        await strict.rejects(first.assertCurrent());
        f.context = { ...context, databaseContextHash: queryContractDigest("session drift") };
        now += 101;
        const changed = await session.prepare(document);
        strict.equal(changed.projectCatalogs?.baseContext.databaseContextHash, f.context.databaseContextHash);
        await strict.rejects(refreshed.assertCurrent());
        session.closeDocument(document.document);
        await strict.rejects(changed.assertCurrent(), /stale/u);
      } finally {
        await session.close();
      }
      strict.equal(f.counts.closes, 1);
      strict.equal(f.counts.sessions, f.counts.sessionCloses);
    }));
  await it("restores captured schema and query evidence offline with independently installed owners", async () =>
    temporary(async (cache) => {
      const f = fixture();
      const live = await prepareLiveContractView({ ...f.base, cache });
      const counts = { ...f.counts };
      const offline = {
        profile,
        schema,
        cache,
        candidates: f.base.candidates,
        contracts: [],
        configuration: {
          ...f.base.configuration,
          mode: "offline" as const,
          context: live.projectCatalogs!.baseContext,
        },
        loadProjectCatalogContributions: () => [contribution],
        loadAnalyzer: () => {
          throw Error("A matching native contract keeps the analyzer cold");
        },
      };
      const restored = await prepareOfflineContractView(offline);
      strict.deepEqual(restored.schema, live.schema);
      strict.deepEqual(restored.context, live.context);
      strict.deepEqual(restored.contracts, live.contracts);
      strict.deepEqual(f.counts, counts);
      await restored.assertCurrent();
      await strict.rejects(
        prepareOfflineContractView({ ...offline, loadProjectCatalogContributions: () => [] }),
        /owner|interpreter/u,
      );
      await strict.rejects(
        prepareOfflineContractView({
          ...offline,
          configuration: {
            ...offline.configuration,
            context: { ...context, databaseContextHash: queryContractDigest("wrong pin") },
          },
        }),
        /Pinned/u,
      );
      await cache.retireContext(context);
      await strict.rejects(restored.assertCurrent(), /changed/u);
    }));
  await it("debounces cancelled source edits before catalog acquisition", async () =>
    temporary(async (cache) => {
      const f = fixture();
      const session = createLiveContractSession({ ...f.base, cache });
      const controller = new AbortController();
      const request = session.prepare({
        document: "file:///editing.ts",
        version: 1,
        candidates: f.base.candidates,
        signal: controller.signal,
      });
      const rejected = strict.rejects(request);
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort(Error("source edited again"));
      await rejected;
      await session.close();
      strict.equal(f.counts.catalogs, 0);
    }));
  await it("drains context publication before closing a cancelled catalog session", async () =>
    temporary(async (cache) => {
      const f = fixture();
      let started!: () => void;
      let release!: () => void;
      const publishing = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let published = false;
      const session = createLiveContractSession({
        ...f.base,
        cache: {
          ...cache,
          async publishContext(input) {
            started();
            await gate;
            const result = await cache.publishContext(input);
            published = true;
            return result;
          },
        },
      });
      const controller = new AbortController();
      const preparation = session.prepare({
        document: "file:///cancelled-publication.ts",
        version: 1,
        candidates: f.base.candidates,
        signal: controller.signal,
      });
      const rejected = strict.rejects(preparation);
      let closed = false;
      try {
        await publishing;
        controller.abort(Error("source changed during publication"));
        await rejected;
        const closing = session.close().then(() => {
          closed = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        strict.equal(closed, false, "Session shutdown must retain ownership of the pending disk write");
        release();
        await closing;
        strict.equal(published, true);
        strict.equal(f.counts.catalogs, 0);
      } finally {
        release();
        controller.abort();
        await rejected;
        await session.close();
      }
    }));
  await it("bounds queued session capture and closes its shared owner once", async () =>
    temporary(async (cache) => {
      const f = fixture();
      let loading!: () => void;
      const started = new Promise<void>((resolve) => {
        loading = resolve;
      });
      const session = createLiveContractSession({
        ...f.base,
        cache,
        live: { ...f.base.live, batchDeadlineMs: 1000 },
        projectCatalogs: {
          capture: true,
          loadContributions() {
            loading();
            return new Promise<never>(() => {});
          },
        },
      });
      const first = session.prepare({ document: "file:///first.ts", version: 1, candidates: f.base.candidates });
      const firstResult = strict.rejects(first);
      await started;
      const controller = new AbortController();
      const second = session.prepare({
        document: "file:///second.ts",
        version: 1,
        candidates: f.base.candidates,
        signal: controller.signal,
      });
      const secondResult = strict.rejects(second, /cancelled/u);
      controller.abort(Error("cancelled"));
      await secondResult;
      await firstResult;
      await session.close();
      strict.equal(f.counts.factories, 1);
      strict.equal(f.counts.closes, 1);
      strict.equal(session.status().activePreparations, 0);
    }));
  await it("retires a disproved pinned base even before any context head was published", async () =>
    temporary(async (cache) => {
      const f = fixture();
      f.context = { ...context, databaseContextHash: queryContractDigest("different database epoch") };
      const pinned = { ...f.base.configuration, context };
      await strict.rejects(
        prepareLiveContractView({ ...f.base, cache, configuration: pinned }),
        /Pinned catalog context/u,
      );
      const scope = createAnalysisContextScope({ ...f.base, configuration: pinned });
      strict.equal((await cache.lookupContext(scope, context)).recorded?.status, "stale");
      strict.equal(f.counts.catalogs, 0);
      strict.equal(f.counts.closes, 1);
    }));
  await it("bounds stalled contribution loading and cleanup and disposes late factories", async () =>
    temporary(async (cache) => {
      const f = fixture();
      await strict.rejects(
        prepareLiveContractView({
          ...f.base,
          cache,
          projectCatalogs: { capture: true, loadContributions: () => new Promise<never>(() => {}) },
          live: { ...f.base.live, batchDeadlineMs: 20 },
        }),
      );
      strict.equal(f.counts.closes, 1);
      await strict.rejects(
        prepareLiveContractView({
          ...f.base,
          cache,
          live: { adapter: () => ({ ...f.services(), close: () => new Promise(() => {}) }), batchDeadlineMs: 20 },
        }),
      );
      let resolve!: (value: LiveAnalysisServices) => void;
      const controller = new AbortController();
      const waiting = prepareLiveContractView({
        ...f.base,
        cache,
        signal: controller.signal,
        live: {
          adapter: () =>
            new Promise<LiveAnalysisServices>((done) => {
              resolve = done;
            }),
        },
      });
      for (let attempts = 0; !resolve && attempts < 10; attempts++) await Promise.resolve();
      controller.abort(Error("cancelled"));
      await strict.rejects(waiting, /cancelled/u);
      const before = f.counts.closes;
      resolve(f.services());
      for (let attempts = 0; f.counts.closes === before && attempts < 20; attempts++) await Promise.resolve();
      strict.equal(f.counts.closes, before + 1);
      const calls = f.counts.factories;
      await strict.rejects(prepareLiveContractView({ ...f.base, cache, signal: controller.signal }), /cancelled/u);
      strict.equal(f.counts.factories, calls);
    }));
});
