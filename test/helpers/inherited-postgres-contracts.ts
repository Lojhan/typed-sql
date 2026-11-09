import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { strict } from "poku";
import {
  createContractDialect,
  createNativeLiveAnalysisRunner,
  createQueryContractIndex,
  createStaticQueryClaim,
  exportQueryContracts,
  loadQueryContracts,
  openAnalysisCache,
  parseContractQualificationPolicy,
  queryContractDigest,
} from "../../packages/analysis/src/index.js";
import { inheritedPostgres } from "../../packages/analysis/test/helpers/inherited-postgres.js";
import { collectSourceQueryCandidates, compileSource } from "../../packages/compiler/src/index.js";
import { decodeQueryResultRows, type SchemaSnapshot, sql, withQueryValuePlan } from "../../packages/core/src/index.js";
import type { PgNativeContractOptions } from "../../packages/postgres/src/pg-contracts.js";

/** A contributed grammar inherits actual base mechanics, with its own semantic/context identity. */
export async function assertInheritedPostgresContracts(
  options: Omit<PgNativeContractOptions, "schema">,
  schema: SchemaSnapshot,
  application: string,
  directory: string,
): Promise<void> {
  const owner = inheritedPostgres(schema);
  const source = application.replace('"@typed-sql/postgres"', JSON.stringify(owner.profile.sqlModule));
  const extracted = collectSourceQueryCandidates({ source, profile: owner.profile, schema: owner.snapshot });
  strict.equal(extracted.complete, true);
  strict.deepEqual(extracted.diagnostics, []);
  strict.equal(extracted.candidates.length, 1);
  const candidate = extracted.candidates[0]!;
  const analysis = owner.analyzer.analyze(candidate.sql, owner.snapshot);
  strict.ok(analysis.diagnostics.some((item) => item.code === "TSQ408"));
  const adapter = owner.native(options);
  strict.equal(adapter.projectCatalogOwner, undefined, "Reusable catalog permissions require an explicit child owner");
  strict.equal(adapter.accept({ sql: "DELETE FROM unsafe", parameterOccurrences: [] }).accepted, false);
  const run = createNativeLiveAnalysisRunner({ adapter, contribution: owner.contribution });
  const policy = parseContractQualificationPolicy({
    mode: "native-required",
    owner: { id: owner.contribution.id, version: owner.contribution.version },
    requiredNativeFacets: ["runtime-type"],
  });
  const temporary = await mkdtemp(join(directory, ".typed-sql-inherited-contract-"));
  try {
    const cacheOptions = {
      directory: join(temporary, "cache"),
      workspaceContext: queryContractDigest("derived-grammar-proof"),
    };
    const cache = await openAnalysisCache(cacheOptions);
    for (let attempt = 0; ; attempt++) {
      const context = await adapter.inspectContext();
      strict.equal(context.grammar.id, owner.profile.id);
      strict.equal(context.grammar.version, owner.profile.grammarVersion);
      const request = {
        connectionContext: queryContractDigest("derived-native-target"),
        adapter: { id: adapter.id, version: adapter.version },
        candidate: { sql: candidate.sql, parameterOccurrences: candidate.parameterOccurrences },
        staticClaim: createStaticQueryClaim({ sql: candidate.sql, context, analysis }),
        policy,
      };
      const token = (await cache.lookup(request)).token;
      const outcome = await run(request, new AbortController().signal);
      if (outcome.kind === "stale-context" && attempt < 2) continue;
      strict.equal(outcome.kind, "usable-recorded-context");
      if (outcome.kind !== "usable-recorded-context") throw Error("Inherited native contribution did not qualify");
      strict.equal(outcome.contract.valuePlan.dialect, owner.profile.id);
      strict.equal(outcome.contract.nativeEvidence!.columns[0]!.nullable.status, "unknown");
      strict.equal(outcome.contract.valuePlan.columns[0]!.nullable, true);
      strict.equal((await cache.publish({ token, request, outcome })).status, "published");
      const reopened = await openAnalysisCache(cacheOptions);
      const cached = await reopened.lookupRecorded({
        candidate: request.candidate,
        context,
        connectionContext: request.connectionContext,
        adapter: request.adapter,
        policy,
      });
      strict.equal(cached.cached?.freshness, "unverified");
      strict.equal(cached.cached?.outcome.kind, "usable-recorded-context");
      if (cached.cached?.outcome.kind !== "usable-recorded-context") throw Error("Missing inherited cached contract");
      strict.equal(cached.cached.outcome.contract.digest, outcome.contract.digest);
      const durable = join(temporary, "contracts");
      await exportQueryContracts(durable, [cached.cached.outcome.contract]);
      const contracts = await loadQueryContracts(durable);
      strict.equal(
        createQueryContractIndex(contracts).resolve(
          { ...context, grammar: { id: "postgres", version: context.grammar.version } },
          candidate.sql,
        ),
        undefined,
      );
      const dialect = createContractDialect({
        profile: owner.profile,
        context,
        contracts,
        qualificationPolicyHash: queryContractDigest(policy),
      });
      const compiled = compileSource({ source, schema: owner.snapshot, dialect, runtimeMetadata: true });
      strict.deepEqual(compiled.diagnostics, []);
      strict.equal(compiled.queries.length, 1);
      strict.match(compiled.queries[0]!.rowType, /result.*bigint.*null/u);
      strict.match(compiled.queries[0]!.parameterType, /bigint.*null/u);
      strict.deepEqual(compiled.queries[0]!.valuePlan, outcome.contract.valuePlan);
      const [before, after] = candidate.sql.split("$1");
      strict.equal(candidate.parameterOccurrences.length, 1);
      if (!before || !after) throw Error("Expected one parameter inside the inherited candidate");
      const query = withQueryValuePlan(sql`${sql.raw(before)}${1n}${sql.raw(after)}`, compiled.queries[0]!.valuePlan!);
      strict.deepEqual(
        decodeQueryResultRows(query, [{ result: 4n }, { result: null }], {
          id: "inherited-decoder-proof",
          dialect: owner.profile.id,
          typePolicyHash: context.typePolicyHash,
          integer: "lossless",
          jsonWire: "text",
        }),
        [{ result: 4n }, { result: null }],
      );
      break;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
