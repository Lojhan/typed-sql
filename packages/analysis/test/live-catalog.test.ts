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
      strict.throws(() => createLiveContractSession({ ...f.base, cache }), /persisted catalog cache/u);
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
