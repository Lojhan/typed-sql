import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { unknownQuerySemantics } from "../../core/src/index.js";
import { createQueryContract, openAnalysisCache, prepareOfflineContractView } from "../src/index.js";
import { configuration, context, contract, profile, request, result, schema } from "./helpers/host-fixture.js";
import { hash } from "./helpers/live-fixture.js";

const options = { profile, schema, configuration, candidates: [request.candidate], contracts: [contract] };
const ownerPlugin = {
  ...profile,
  analyze: (sql: string) => ({
    columns: [],
    parameters: [],
    diagnostics: [],
    semantics: unknownQuerySemantics({ start: 0, end: sql.length, line: 1, column: 1 }, "fixture"),
  }),
};
await describe("offline contract-first preparation", async () => {
  await it("keeps the owner unloaded for durable hits, deduplicates candidates and rejects uncovered SQL", async () => {
    const view = await prepareOfflineContractView({
      ...options,
      candidates: [request.candidate, request.candidate],
      loadAnalyzer() {
        throw Error("must stay cold");
      },
    });
    strict.equal(view.contracts.length, 1);
    strict.deepEqual(view.dialect.analyze(request.candidate.sql, schema).diagnostics, []);
    strict.equal(view.dialect.analyze("SELECT 2 AS value", schema).diagnostics[0]?.code, "TSQ406");
    strict.ok(Object.isFrozen(view));
    strict.ok(Object.isFrozen(view.contracts));
    strict.equal(
      view.dialect.analyze(request.candidate.sql, Object.assign({}, schema, { version: "changed" })).diagnostics[0]
        ?.code,
      "TSQ406",
    );
  });
  await it("loads the owner only for uncovered hybrid queries and preserves analysis context", async () => {
    let loaded = 0,
      analyzed = 0;
    const hybrid = { ...configuration, qualification: { ...configuration.qualification, mode: "hybrid" as const } };
    const view = await prepareOfflineContractView({
      ...options,
      configuration: hybrid,
      contracts: [],
      loadAnalyzer() {
        loaded++;
        return {
          ...ownerPlugin,
          runtimeValueType(this: { readonly id: string }) {
            return this.id === profile.id ? ("number" as const) : ("unknown" as const);
          },
          analyze(sql, _snapshot, _policy, analysisContext) {
            analyzed++;
            strict.equal(analysisContext?.runtimeValidation, true);
            return ownerPlugin.analyze(sql);
          },
        };
      },
    });
    strict.equal(loaded, 1);
    strict.equal(
      view.dialect.runtimeValueType?.({ databaseType: "integer", tsType: "number", nullable: false }, {}),
      "number",
    );
    strict.equal(analyzed, 0);
    strict.deepEqual(
      view.dialect.analyze(request.candidate.sql, schema, {}, { runtimeValidation: true }).diagnostics,
      [],
    );
    strict.equal(analyzed, 1);
    strict.equal(view.dialect.analyze(request.candidate.sql, schema, { changed: true }).diagnostics[0]?.code, "TSQ406");
    strict.equal(analyzed, 1);
    const noOwner = await prepareOfflineContractView({ ...options, configuration: hybrid, contracts: [] });
    strict.equal(noOwner.dialect.analyze(request.candidate.sql, schema).diagnostics[0]?.code, "TSQ406");
    const strictView = await prepareOfflineContractView({
      ...options,
      contracts: [],
      loadAnalyzer() {
        throw Error("native-required stays cold");
      },
    });
    strict.equal(strictView.dialect.analyze(request.candidate.sql, schema).diagnostics[0]?.code, "TSQ406");
    await strict.rejects(
      prepareOfflineContractView({
        ...options,
        contracts: [],
        configuration: hybrid,
        loadAnalyzer: () => ({ ...ownerPlugin, grammarVersion: "2" }),
      }),
      /registration differs/u,
    );
  });
  await it("uses recorded cache hits and lets known negatives retire durable support", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-offline-view-"));
    try {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash });
      await cache.publish({ token: (await cache.lookup(request)).token, request, outcome: result });
      const view = await prepareOfflineContractView({
        ...options,
        cache,
        contracts: [],
        loadAnalyzer() {
          throw Error("cache hit stays cold");
        },
      });
      strict.deepEqual(view.dialect.analyze(request.candidate.sql, schema).diagnostics, []);
      await cache.publish({
        token: (await cache.lookup(request)).token,
        request,
        outcome: { kind: "conflict", code: "known-conflict" },
      });
      const blocked = await prepareOfflineContractView({
        ...options,
        cache,
        loadAnalyzer() {
          throw Error("must not override conflict");
        },
      });
      strict.equal(blocked.dialect.analyze(request.candidate.sql, schema).diagnostics[0]?.code, "TSQ406");
      strict.match(
        blocked.dialect.analyze(request.candidate.sql, schema).diagnostics[0]!.message,
        /conflict \(known-conflict\)/u,
      );
      const { cache: _, ...withoutCache } = configuration;
      await strict.rejects(
        prepareOfflineContractView({ ...options, cache, configuration: withoutCache }),
        /explicit connection/u,
      );
      await cache.invalidate();
      await cache.publish({
        token: (await cache.lookup(request)).token,
        request,
        outcome: { kind: "stale-context", code: "context-changed" },
      });
      const otherSql = "SELECT 2 AS value";
      const otherContract = createQueryContract({
        sql: otherSql,
        context,
        origin: "offline-rule",
        valuePlan: contract.valuePlan,
      });
      const contextBlocked = await prepareOfflineContractView({
        ...options,
        cache,
        configuration: { ...configuration, qualification: { ...configuration.qualification, mode: "hybrid" } },
        candidates: [{ sql: otherSql, parameterOccurrences: [] }],
        contracts: [otherContract],
      });
      strict.match(contextBlocked.dialect.analyze(otherSql, schema).diagnostics[0]!.message, /stale-context/u);
      await cache.invalidate();
      const missing = await prepareOfflineContractView({ ...options, cache, contracts: [] });
      strict.equal(missing.contracts.length, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("enforces profile, policy, qualification and resource bounds before fallback", async () => {
    for (const patch of [
      { configuration: { ...configuration, mode: "frozen" as const } },
      { profile: ownerPlugin },
      { profile: { ...profile, grammarVersion: "2" } },
      { schema: { ...schema, version: "changed" } },
      { typePolicy: { changed: true } },
      {
        contracts: [
          createQueryContract({
            sql: request.candidate.sql,
            context,
            origin: "offline-rule",
            valuePlan: contract.valuePlan,
          }),
        ],
      },
      { candidates: Array.from({ length: 4097 }, () => request.candidate) },
      { candidates: Array.from({ length: 17 }, () => ({ sql: "x".repeat(1024 * 1024), parameterOccurrences: [] })) },
    ])
      await strict.rejects(prepareOfflineContractView({ ...options, ...patch }));
    const hybrid = { ...configuration, qualification: { ...configuration.qualification, mode: "hybrid" as const } };
    const offline = createQueryContract({
      sql: request.candidate.sql,
      context,
      origin: "offline-rule",
      valuePlan: contract.valuePlan,
    });
    strict.deepEqual(
      (await prepareOfflineContractView({ ...options, configuration: hybrid, contracts: [offline] })).dialect.analyze(
        request.candidate.sql,
        schema,
      ).diagnostics,
      [],
    );
  });
});
