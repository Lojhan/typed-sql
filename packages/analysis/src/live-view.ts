import {
  assertDialectPlugin,
  assertDialectProfile,
  type DialectPlugin,
  type DialectProfile,
  type SchemaSnapshot,
} from "@typed-sql/core";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { namedAnalysisError } from "./analysis-errors.js";
import type { AnalysisCache, AnalysisCacheToken } from "./cache.js";
import { type NativeContractCandidate, parseNativeContractCandidate } from "./candidate.js";
import { canonicalContractData, exactSqlDigest, queryContractDigest } from "./canonical.js";
import {
  type AnalysisConfiguration,
  createAnalysisContextScope,
  defineAnalysisConfiguration,
} from "./configuration.js";
import { assertContextScope } from "./context-scope.js";
import type { QueryContract, QueryContractContext } from "./contracts.js";
import { createContractDialect } from "./dialect.js";
import {
  createLiveAnalysisScheduler,
  createNativeLiveAnalysisRunner,
  type LiveAnalysisOutcome,
  type LiveAnalysisRequest,
  type LiveAnalysisScheduler,
  type LiveAnalysisSubscription,
} from "./live.js";
import { prepareCapturedCatalogView } from "./live-catalog.js";
import {
  inspectNativeContext,
  NativeContextChangedError,
  NativeContextObservationChangedError,
} from "./native-context.js";
import { createPersistentLiveAnalysisRunner } from "./persistent-live.js";
import type { ProjectCatalogClosure } from "./project-catalog.js";
import { createStaticQueryClaim } from "./reconciliation.js";
import {
  type AnalysisOwnerLoader,
  type AnalysisRegistration,
  defineAnalysisRegistration,
  type LiveAnalysisRegistration,
  type LiveAnalysisServices,
} from "./registration.js";

export interface LiveContractView<Snapshot extends SchemaSnapshot, Policy> {
  readonly schema: Snapshot;
  readonly projectCatalogs?: ProjectCatalogClosure;
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly contracts: readonly QueryContract[];
  readonly context: QueryContractContext;
  assertCurrent(): Promise<void>;
  readonly outcomes: readonly { readonly sqlDigest: string; readonly outcome: LiveAnalysisOutcome }[];
}

/** A finite, explicitly enabled native prepass. Synchronous compilation uses only its final view. */
export interface LiveContractPreparation<Snapshot extends SchemaSnapshot, Policy> {
  readonly profile: DialectProfile<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
  readonly configuration: AnalysisConfiguration;
  readonly live: LiveAnalysisRegistration<Snapshot, Policy>;
  readonly candidates: readonly NativeContractCandidate[];
  readonly cache: AnalysisCache;
  readonly loadAnalyzer: AnalysisOwnerLoader<Snapshot, Policy>;
  readonly signal?: AbortSignal;
  readonly recordedContext?: QueryContractContext;
  readonly recordedProjectCatalogs?: ProjectCatalogClosure;
  readonly projectCatalogs?: AnalysisRegistration<Snapshot, Policy>["projectCatalogs"];
}
class ObservedContextChangedError extends NativeContextChangedError {}
function snapshotCandidates(candidates: readonly NativeContractCandidate[]): readonly NativeContractCandidate[] {
  if (candidates.length > 4096) throw new RangeError("Live analysis candidate limit exceeded");
  const owned = candidates.map(parseNativeContractCandidate);
  if (owned.reduce((bytes, candidate) => bytes + Buffer.byteLength(candidate.sql), 0) > 16 * 1024 * 1024)
    throw new RangeError("Live analysis candidate byte limit exceeded");
  return Object.freeze(owned);
}
export async function prepareLiveContractView<Snapshot extends SchemaSnapshot, Policy>(
  input: LiveContractPreparation<Snapshot, Policy>,
): Promise<LiveContractView<Snapshot, Policy>> {
  const configuration = defineAnalysisConfiguration(input.configuration);
  if (input.projectCatalogs?.capture)
    return prepareCapturedCatalogView(
      { ...input, candidates: snapshotCandidates(input.candidates) },
      prepareLiveContractView,
    );
  if (configuration.context !== undefined) return prepareLiveContractViewWithScheduler(input);
  const live = defineAnalysisRegistration({ ...configuration, live: input.live }).live;
  if (!live) throw new TypeError("Live preparation requires a native registration");
  const candidates = snapshotCandidates(input.candidates);
  const controller = new AbortController();
  input.signal?.throwIfAborted();
  const abort = () => controller.abort(input.signal!.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  // Fresh attempts share one batch deadline. Cleanup must settle before another lease is created.
  const timer = setTimeout(
    () => controller.abort(new Error("Live analysis batch deadline exceeded")),
    live.batchDeadlineMs ?? 60_000,
  );
  try {
    for (let attempt = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      try {
        const view = await prepareLiveContractViewWithScheduler({
          ...input,
          configuration,
          live,
          candidates,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        return view;
      } catch (error) {
        controller.signal.throwIfAborted();
        if (!(error instanceof ObservedContextChangedError) || attempt >= 2) throw error;
      }
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}
/** Internal borrowing boundary: the session owns the scheduler and transport cleanup. */
export async function prepareLiveContractViewWithScheduler<Snapshot extends SchemaSnapshot, Policy>(
  input: LiveContractPreparation<Snapshot, Policy>,
  schedulerFactory = createLiveAnalysisScheduler,
): Promise<LiveContractView<Snapshot, Policy>> {
  const configuration = defineAnalysisConfiguration(input.configuration),
    profile = input.profile;
  const registration = defineAnalysisRegistration({ ...configuration, live: input.live }).live!;
  assertDialectProfile(profile);
  const typePolicy = input.typePolicy ?? profile.defaultTypePolicy;
  if (configuration.mode !== "live" || !configuration.cache || "analyze" in profile)
    throw new TypeError("Live preparation requires live mode, cache target identity and a lightweight profile");
  const target = configuration.cache,
    scope = createAnalysisContextScope(input),
    automatic = configuration.context === undefined;
  let context = configuration.context,
    observationToken: AnalysisCacheToken | undefined;
  const cacheTokens = new Map<string, AnalysisCacheToken>();
  const selectedContext = (): QueryContractContext => {
    if (!context) throw new TypeError("Live context observation has not completed");
    return context;
  };
  const candidates = snapshotCandidates(input.candidates);
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
    let owner: DialectPlugin<Snapshot, Policy> | undefined;
    if (!unique.length && context) return view(outcomes);
    const captured = automatic ? await input.cache.lookupContext(scope) : undefined;
    owner = unique.length ? await input.loadAnalyzer() : undefined;
    signal.throwIfAborted();
    if (owner) assertDialectPlugin(owner);
    if (
      owner &&
      (owner.id !== profile.id ||
        owner.grammarVersion !== profile.grammarVersion ||
        owner.sqlModule !== profile.sqlModule)
    )
      throw new TypeError("Live analyzer registration differs from the selected profile");
    services = await registration.adapter({ schema: input.schema, typePolicy, signal });
    signal.throwIfAborted();
    if (!services || typeof services.close !== "function") throw new TypeError("Live adapter requires owned cleanup");
    if (
      services.connectionContext !== target.connectionContext ||
      services.adapter?.id !== target.adapter.id ||
      services.adapter.version !== target.adapter.version ||
      canonicalContractData(services.adapter.grammar) !== canonicalContractData(scope.grammar) ||
      services.contribution?.id !== configuration.qualification.owner.id ||
      services.contribution.version !== configuration.qualification.owner.version ||
      canonicalContractData(services.contribution.grammar) !== canonicalContractData(scope.grammar) ||
      typeof services.inspectContext !== "function"
    )
      throw new TypeError(
        "Live service registration differs from the selected target, adapter or reconciliation owner",
      );
    await inspect(true);
    const requests: LiveAnalysisRequest[] = unique.map((candidate) => ({
      candidate,
      connectionContext: target.connectionContext,
      adapter: target.adapter,
      policy: configuration.qualification,
      staticClaim: createStaticQueryClaim({
        sql: candidate.sql,
        context: selectedContext(),
        analysis: owner!.analyze(candidate.sql, input.schema, typePolicy, { runtimeValidation: true }),
      }),
    }));
    const maxActive = registration.maxActive ?? 8;
    scheduler = schedulerFactory({
      debounceMs: 0,
      maxActive,
      maxQueued: maxActive * 2,
      maxSubscribers: maxActive * 2,
      maxRecords: maxActive * 2,
      concurrencyPerContext: registration.concurrencyPerContext ?? 2,
      deadlineMs: registration.deadlineMs ?? 5000,
      run: createPersistentLiveAnalysisRunner({
        cache: input.cache,
        onCacheSnapshot: (token) => {
          cacheTokens.set(token.requestKey, token);
        },
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
            await input.cache.retireContext(selectedContext());
            controller.abort(
              new ObservedContextChangedError(
                "Live database context changed during acquisition; refresh the recorded context.",
              ),
            );
          }
        }
      }),
    );
    await inspect(false);
    signal.throwIfAborted();
    if (automatic) {
      const committed = await input.cache.publishContext({
        token: observationToken!,
        scope,
        context: selectedContext(),
      });
      if (committed.status !== "published")
        throw namedAnalysisError(
          "LiveContextPublicationError",
          `Live context selection ${committed.status}; retry against current inputs`,
        );
      observationToken = committed.token;
    }
    return view(outcomes);
    async function inspect(initial: boolean) {
      let current: QueryContractContext;
      try {
        current = await inspectNativeContext(services!, signal);
      } catch (error) {
        if (error instanceof NativeContextObservationChangedError) {
          const previous = context ?? captured?.recorded?.context ?? input.recordedContext;
          if (previous) await input.cache.retireContext(previous);
          throw new ObservedContextChangedError(error.message);
        }
        throw error;
      }
      signal.throwIfAborted();
      try {
        assertContextScope(current, scope);
      } catch (error) {
        const previous = context ?? captured?.recorded?.context ?? input.recordedContext;
        if (previous) await input.cache.retireContext(previous);
        throw error;
      }
      if (initial && automatic) {
        const observed = await input.cache.publishContext({
          token: captured!.token,
          scope,
          context: current,
          ...(input.recordedContext ? { previousContext: input.recordedContext } : {}),
        });
        if (observed.status !== "published")
          throw namedAnalysisError(
            "LiveContextPublicationError",
            `Live context selection ${observed.status}; retry against current inputs`,
          );
        context = current;
        observationToken = observed.token;
        return;
      }
      if (canonicalContractData(current) !== canonicalContractData(selectedContext())) {
        await input.cache.retireContext(selectedContext());
        throw new ObservedContextChangedError(
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
        context: selectedContext(),
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
        ...(profile.runtimeValueType === undefined && owner?.runtimeValueType !== undefined
          ? { runtimeValueType: owner.runtimeValueType.bind(owner) }
          : {}),
        analyze(sql, schema, policy = typePolicy, analysisContext) {
          const analysis = consumer.analyze(sql, schema, policy, analysisContext),
            failure = failures.get(exactSqlDigest(sql));
          if (
            configuration.qualification.mode === "hybrid" &&
            failure?.kind === "partial" &&
            failure.code === "unsupported-statement" &&
            owner &&
            calculateSchemaHash(schema) === selectedContext().schemaHash &&
            calculateTypePolicyHash(policy ?? {}) === selectedContext().typePolicyHash
          )
            return owner.analyze(sql, schema, policy, analysisContext);
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
      return Object.freeze({
        schema: input.schema,
        dialect,
        context: selectedContext(),
        async assertCurrent() {
          if (
            !(await input.cache.areTokensCurrent([
              ...cacheTokens.values(),
              ...(observationToken ? [observationToken] : []),
            ]))
          )
            throw namedAnalysisError(
              "LiveViewInvalidatedError",
              "Live evidence/context selection changed; retry current analysis inputs",
            );
        },
        contracts: Object.freeze(contracts),
        outcomes: Object.freeze([...results]),
      });
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
  input.signal?.throwIfAborted();
  return result.value;
}
