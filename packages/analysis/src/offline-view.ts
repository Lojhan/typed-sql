import {
  assertDialectPlugin,
  assertDialectProfile,
  type DialectPlugin,
  type DialectProfile,
  type SchemaSnapshot,
} from "@typed-sql/core";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import type { AnalysisCache } from "./cache.js";
import { type NativeContractCandidate, parseNativeContractCandidate } from "./candidate.js";
import { exactSqlDigest, queryContractDigest } from "./canonical.js";
import { type AnalysisConfiguration, defineAnalysisConfiguration } from "./configuration.js";
import { createQueryContractIndex, type QueryContract } from "./contracts.js";
import { createContractDialect } from "./dialect.js";
import type { LiveAnalysisFailure } from "./live.js";

/** Explicit async preparation; the returned compiler surface remains synchronous and offline. */
export async function prepareOfflineContractView<Snapshot extends SchemaSnapshot, Policy>(input: {
  readonly profile: DialectProfile<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
  readonly configuration: AnalysisConfiguration;
  readonly candidates: readonly NativeContractCandidate[];
  readonly contracts: readonly QueryContract[];
  readonly cache?: AnalysisCache;
  readonly loadAnalyzer?: () => Promise<DialectPlugin<Snapshot, Policy>> | DialectPlugin<Snapshot, Policy>;
}): Promise<{ readonly dialect: DialectPlugin<Snapshot, Policy>; readonly contracts: readonly QueryContract[] }> {
  const configuration = defineAnalysisConfiguration(input.configuration),
    profile = input.profile;
  assertDialectProfile(profile);
  if ("analyze" in profile || configuration.mode !== "offline")
    throw new TypeError("Offline preparation requires a lightweight profile and offline mode");
  const context = configuration.context,
    policy = input.typePolicy ?? profile.defaultTypePolicy;
  if (
    context.grammar.id !== profile.id ||
    context.grammar.version !== profile.grammarVersion ||
    context.schemaHash !== calculateSchemaHash(input.schema) ||
    context.typePolicyHash !== calculateTypePolicyHash(policy ?? {})
  )
    throw new TypeError("Offline analysis profile, schema or decoding policy differs");
  if (input.candidates.length > 4096) throw new RangeError("Offline analysis candidate limit exceeded");
  const candidates = input.candidates.map(parseNativeContractCandidate);
  if (candidates.reduce((bytes, candidate) => bytes + Buffer.byteLength(candidate.sql), 0) > 16 * 1024 * 1024)
    throw new RangeError("Offline analysis candidate byte limit exceeded");
  const durable = createQueryContractIndex(input.contracts),
    contracts: QueryContract[] = [];
  const blocked = new Map<string, LiveAnalysisFailure>(),
    missing = new Set<string>(),
    prepared = new Set<string>();
  const policyHash = queryContractDigest(configuration.qualification);
  for (const candidate of candidates) {
    const key = exactSqlDigest(candidate.sql);
    if (prepared.has(key)) continue;
    prepared.add(key);
    const existing = durable.resolve(context, candidate.sql);
    if (
      existing &&
      (existing.origin !== "offline-rule" || configuration.qualification.mode === "native-required") &&
      existing.qualification?.policyHash !== policyHash
    )
      throw new TypeError("Durable query contract does not meet the configured qualification policy");
    let cached: QueryContract | undefined;
    if (input.cache) {
      if (!configuration.cache) throw new TypeError("Offline cache requires an explicit connection/adapter identity");
      const lookup = await input.cache.lookupRecorded({
        candidate,
        context,
        adapter: configuration.cache.adapter,
        connectionContext: configuration.cache.connectionContext,
        policy: configuration.qualification,
      });
      const outcome = lookup.cached?.outcome;
      if (outcome?.kind === "usable-recorded-context") cached = outcome.contract;
      else if (outcome) {
        blocked.set(key, outcome);
        continue;
      }
    }
    if (existing) contracts.push(existing);
    if (cached) contracts.push(cached);
    if (!existing && !cached) missing.add(key);
  }
  // Distinct proofs may still disagree. Index construction rejects conflicting plans for exact inputs.
  const index = createQueryContractIndex(contracts);
  const consumer = createContractDialect({
    profile,
    context,
    contracts,
    ...(configuration.qualification.mode === "native-required" ? { qualificationPolicyHash: policyHash } : {}),
  });
  let owner: DialectPlugin<Snapshot, Policy> | undefined;
  if (missing.size && configuration.qualification.mode === "hybrid" && input.loadAnalyzer) {
    owner = await input.loadAnalyzer();
    assertDialectPlugin(owner);
    if (
      owner.id !== profile.id ||
      owner.grammarVersion !== profile.grammarVersion ||
      owner.sqlModule !== profile.sqlModule
    )
      throw new TypeError("Offline analyzer registration differs from the selected profile");
  }
  const dialect: DialectPlugin<Snapshot, Policy> = Object.freeze({
    ...profile,
    ...(profile.runtimeValueType === undefined && owner?.runtimeValueType !== undefined
      ? { runtimeValueType: owner.runtimeValueType.bind(owner) }
      : {}),
    analyze(sql, schema, selectedPolicy = policy, analysisContext) {
      const key = exactSqlDigest(sql);
      const failure = blocked.get(key);
      if (failure) {
        const analysis = consumer.analyze(sql, schema, selectedPolicy, analysisContext);
        return {
          ...analysis,
          diagnostics: analysis.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            message: `Recorded query evidence is ${failure.kind} (${failure.code}).`,
            suggestion: "Refresh and resolve the recorded evidence before using this query contract.",
          })),
        };
      }
      if (
        !prepared.has(key) ||
        index.resolve(context, sql) ||
        !owner ||
        calculateSchemaHash(schema) !== context.schemaHash ||
        calculateTypePolicyHash(selectedPolicy ?? {}) !== context.typePolicyHash
      )
        return consumer.analyze(sql, schema, selectedPolicy, analysisContext);
      return owner.analyze(sql, schema, selectedPolicy, analysisContext);
    },
  });
  return Object.freeze({
    dialect,
    contracts: Object.freeze([...new Map(contracts.map((item) => [item.digest, item])).values()]),
  });
}
