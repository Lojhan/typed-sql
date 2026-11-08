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
import { canonicalContractData, exactSqlDigest, queryContractDigest } from "./canonical.js";
import { type AnalysisConfiguration, defineAnalysisConfiguration } from "./configuration.js";
import { parseQueryContractContext, type QueryContract } from "./contracts.js";
import { createContractDialect } from "./dialect.js";
import {
  createLiveAnalysisScheduler,
  createNativeLiveAnalysisRunner,
  type LiveAnalysisOutcome,
  type LiveAnalysisRequest,
  type LiveAnalysisScheduler,
  type LiveAnalysisSubscription,
} from "./live.js";
import { createPersistentLiveAnalysisRunner } from "./persistent-live.js";
import { createStaticQueryClaim } from "./reconciliation.js";
import {
  type AnalysisOwnerLoader,
  defineAnalysisRegistration,
  type LiveAnalysisRegistration,
  type LiveAnalysisServices,
} from "./registration.js";

export interface LiveContractView<Snapshot extends SchemaSnapshot, Policy> {
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly contracts: readonly QueryContract[];
  readonly outcomes: readonly { readonly sqlDigest: string; readonly outcome: LiveAnalysisOutcome }[];
}

/** A finite, explicitly enabled native prepass. Synchronous compilation uses only its final view. */
export async function prepareLiveContractView<Snapshot extends SchemaSnapshot, Policy>(input: {
  readonly profile: DialectProfile<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
  readonly configuration: AnalysisConfiguration;
  readonly live: LiveAnalysisRegistration<Snapshot, Policy>;
  readonly candidates: readonly NativeContractCandidate[];
  readonly cache: AnalysisCache;
  readonly loadAnalyzer: AnalysisOwnerLoader<Snapshot, Policy>;
  readonly signal?: AbortSignal;
}): Promise<LiveContractView<Snapshot, Policy>> {
  const configuration = defineAnalysisConfiguration(input.configuration),
    profile = input.profile;
  const registration = defineAnalysisRegistration({ ...configuration, live: input.live }).live!;
  assertDialectProfile(profile);
  const context = configuration.context,
    typePolicy = input.typePolicy ?? profile.defaultTypePolicy;
  if (configuration.mode !== "live" || !configuration.cache || "analyze" in profile)
    throw new TypeError("Live preparation requires live mode, cache target identity and a lightweight profile");
  const target = configuration.cache;
  if (
    context.grammar.id !== profile.id ||
    context.grammar.version !== profile.grammarVersion ||
    context.schemaHash !== calculateSchemaHash(input.schema) ||
    context.typePolicyHash !== calculateTypePolicyHash(typePolicy ?? {})
  )
    throw new TypeError("Live analysis profile, schema or decoding policy differs");
  if (input.candidates.length > 4096) throw new RangeError("Live analysis candidate limit exceeded");
  const candidates = input.candidates.map(parseNativeContractCandidate);
  if (candidates.reduce((bytes, candidate) => bytes + Buffer.byteLength(candidate.sql), 0) > 16 * 1024 * 1024)
    throw new RangeError("Live analysis candidate byte limit exceeded");
  const unique = [...new Map(candidates.map((candidate) => [queryContractDigest(candidate), candidate])).values()];
  const controller = new AbortController(),
    signal = controller.signal;
  const abort = () => controller.abort(input.signal!.reason);
  input.signal?.throwIfAborted();
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Live analysis batch deadline exceeded")),
    registration.batchDeadlineMs ?? 60_000,
  );
  let services: LiveAnalysisServices | undefined, scheduler: LiveAnalysisScheduler | undefined;
  async function produce(): Promise<LiveContractView<Snapshot, Policy>> {
    const outcomes: { sqlDigest: string; outcome: LiveAnalysisOutcome }[] = [];
    if (!unique.length) return view(outcomes);
    const owner = await input.loadAnalyzer();
    signal.throwIfAborted();
    assertDialectPlugin(owner);
    if (
      owner.id !== profile.id ||
      owner.grammarVersion !== profile.grammarVersion ||
      owner.sqlModule !== profile.sqlModule
    )
      throw new TypeError("Live analyzer registration differs from the selected profile");
    const requests: LiveAnalysisRequest[] = unique.map((candidate) => ({
      candidate,
      connectionContext: target.connectionContext,
      adapter: target.adapter,
      policy: configuration.qualification,
      staticClaim: createStaticQueryClaim({
        sql: candidate.sql,
        context,
        analysis: owner.analyze(candidate.sql, input.schema, typePolicy, { runtimeValidation: true }),
      }),
    }));
    services = await registration.adapter({ schema: input.schema, typePolicy, signal });
    signal.throwIfAborted();
    if (!services || typeof services.close !== "function") throw new TypeError("Live adapter requires owned cleanup");
    if (
      services.connectionContext !== target.connectionContext ||
      services.adapter?.id !== target.adapter.id ||
      services.adapter.version !== target.adapter.version ||
      canonicalContractData(services.adapter.grammar) !== canonicalContractData(context.grammar) ||
      services.contribution?.id !== configuration.qualification.owner.id ||
      services.contribution.version !== configuration.qualification.owner.version ||
      canonicalContractData(services.contribution.grammar) !== canonicalContractData(context.grammar) ||
      typeof services.inspectContext !== "function"
    )
      throw new TypeError(
        "Live service registration differs from the selected target, adapter or reconciliation owner",
      );
    await inspect();
    const maxActive = registration.maxActive ?? 8;
    scheduler = createLiveAnalysisScheduler({
      debounceMs: 0,
      maxActive,
      maxQueued: maxActive * 2,
      maxSubscribers: maxActive * 2,
      maxRecords: maxActive * 2,
      concurrencyPerContext: registration.concurrencyPerContext ?? 2,
      deadlineMs: registration.deadlineMs ?? 5000,
      run: createPersistentLiveAnalysisRunner({
        cache: input.cache,
        run: createNativeLiveAnalysisRunner({
          adapter: services.adapter,
          contribution: services.contribution,
          ...(services.classifyError ? { classifyError: services.classifyError.bind(services) } : {}),
        }),
      }),
    });
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(maxActive, requests.length) }, async () => {
        for (;;) {
          signal.throwIfAborted();
          const position = next++,
            request = requests[position];
          if (!request) return;
          const outcome = await acquire(request, position);
          outcomes[position] = Object.freeze({ sqlDigest: exactSqlDigest(request.candidate.sql), outcome });
          if (outcome.kind === "stale-context") {
            await input.cache.retireContext(context);
            controller.abort(
              new Error("Live database context changed during acquisition; refresh the recorded context."),
            );
          }
        }
      }),
    );
    await inspect();
    signal.throwIfAborted();
    return view(outcomes);
    async function inspect() {
      const current = parseQueryContractContext(await services!.inspectContext(signal));
      signal.throwIfAborted();
      if (canonicalContractData(current) !== canonicalContractData(context)) {
        await input.cache.retireContext(context);
        throw new Error(
          "Live database context differs from the selected recorded context; refresh its schema/context inputs.",
        );
      }
    }
    async function acquire(request: LiveAnalysisRequest, position: number): Promise<LiveAnalysisOutcome> {
      let subscription: LiveAnalysisSubscription | undefined;
      let cancelled: (() => void) | undefined;
      try {
        return await new Promise<LiveAnalysisOutcome>((resolve, reject) => {
          cancelled = () => {
            subscription?.cancel();
            reject(signal.reason);
          };
          signal.addEventListener("abort", cancelled, { once: true });
          subscription = scheduler!.subscribe(
            {
              request,
              queryId: String(position),
              ticket: {
                document: "typed-sql:live-batch",
                documentVersion: 0,
                inputGeneration: 0,
                contextGeneration: 0,
                policyGeneration: 0,
              },
            },
            (state) => {
              if (state.kind === "pending") return;
              resolve(
                state.kind === "stale-input"
                  ? { kind: "unavailable", code: "stale-batch-input", retry: "change" }
                  : state,
              );
            },
          );
          if (signal.aborted) cancelled();
        });
      } finally {
        if (cancelled) signal.removeEventListener("abort", cancelled);
        subscription?.cancel();
      }
    }
    function view(
      results: readonly { sqlDigest: string; outcome: LiveAnalysisOutcome }[],
    ): LiveContractView<Snapshot, Policy> {
      const contracts = results.flatMap(({ outcome }) =>
        outcome.kind === "usable-recorded-context" ? [outcome.contract] : [],
      );
      const consumer = createContractDialect({
        profile,
        context,
        contracts,
        qualificationPolicyHash: queryContractDigest(configuration.qualification),
      });
      const failures = new Map(
        results.flatMap(({ sqlDigest, outcome }) =>
          outcome.kind === "usable-recorded-context" ? [] : [[sqlDigest, outcome] as const],
        ),
      );
      const dialect: DialectPlugin<Snapshot, Policy> = Object.freeze({
        ...consumer,
        analyze(sql, schema, policy, analysisContext) {
          const analysis = consumer.analyze(sql, schema, policy, analysisContext),
            failure = failures.get(exactSqlDigest(sql));
          return failure
            ? {
                ...analysis,
                diagnostics: analysis.diagnostics.map((diagnostic) => ({
                  ...diagnostic,
                  message: `Live query qualification is ${failure.kind} (${failure.code}).`,
                  suggestion:
                    "Resolve the native evidence or explicitly select offline checking with matching recorded contracts.",
                })),
              }
            : analysis;
        },
      });
      return Object.freeze({ dialect, contracts: Object.freeze(contracts), outcomes: Object.freeze([...results]) });
    }
  }
  const [result] = await Promise.allSettled([produce()]);
  clearTimeout(timer);
  input.signal?.removeEventListener("abort", abort);
  const cleanup = await Promise.allSettled([
    scheduler?.close(),
    Promise.resolve().then(() => (typeof services?.close === "function" ? services.close() : undefined)),
  ]);
  const failures = cleanup.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
  if (result.status === "rejected") {
    if (failures.length) throw new AggregateError([result.reason, ...failures], "Live analysis and cleanup failed");
    throw result.reason;
  }
  if (failures.length) throw new AggregateError(failures, "Live analysis cleanup failed");
  return result.value;
}
