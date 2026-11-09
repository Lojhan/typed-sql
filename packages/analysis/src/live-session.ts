import { setTimeout as delay } from "node:timers/promises";
import type { SchemaSnapshot } from "@typed-sql/core";
import { namedAnalysisError } from "./analysis-errors.js";
import type { AnalysisCacheToken } from "./cache.js";
import { type NativeContractCandidate, parseNativeContractCandidate } from "./candidate.js";
import { canonicalContractData, exactSqlDigest, queryContractDigest } from "./canonical.js";
import { createAnalysisContextScope } from "./configuration.js";
import { assertContextScope } from "./context-scope.js";
import { parseQueryContractContext, type QueryContractContext } from "./contracts.js";
import {
  createLiveAnalysisScheduler,
  createNativeLiveAnalysisRunner,
  type LiveAnalysisFailure,
  type LiveAnalysisScheduler,
  type LiveAnalysisSchedulerOptions,
  parseLiveAnalysisFailure,
} from "./live.js";
import {
  type LiveContractPreparation,
  type LiveContractView,
  prepareLiveContractView,
  prepareLiveContractViewWithScheduler,
} from "./live-view.js";
import { NativeContextChangedError } from "./native-context.js";
import { createPersistentLiveAnalysisRunner } from "./persistent-live.js";
import { defineAnalysisRegistration, type LiveAnalysisServices } from "./registration.js";

function untilAbort<Value>(work: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
export class LiveContextUnavailableError extends Error {
  constructor(readonly failure: Extract<LiveAnalysisFailure, { kind: "unavailable" }>) {
    super(`Live context is unavailable (${failure.code}); recorded evidence has unverified remote freshness.`);
    this.name = "LiveContextUnavailableError";
  }
}
type SessionInput<Snapshot extends SchemaSnapshot, Policy> = Omit<
  LiveContractPreparation<Snapshot, Policy>,
  "candidates" | "signal"
> & {
  readonly contextIntervalMs?: number;
  readonly now?: () => number;
  readonly onContextChange?: () => void;
};
export interface LiveContractSessionStatus {
  readonly observation: "request-driven";
  readonly freshness: "unverified";
  readonly connection: "unobserved" | "available" | "unavailable";
  readonly lastContextCheckAt?: number;
  readonly activePreparations: number;
}
export interface LiveContractSession<Snapshot extends SchemaSnapshot, Policy> {
  prepare(input: {
    readonly document: string;
    readonly version: number;
    readonly candidates: readonly NativeContractCandidate[];
    readonly signal?: AbortSignal;
  }): Promise<LiveContractView<Snapshot, Policy>>;
  closeDocument(document: string): void;
  status(): LiveContractSessionStatus;
  close(): Promise<void>;
}
/** One explicitly enabled project lifecycle. Ordinary synchronous consumers never call a database. */
export function createLiveContractSession<Snapshot extends SchemaSnapshot, Policy>(
  input: SessionInput<Snapshot, Policy>,
): LiveContractSession<Snapshot, Policy> {
  const registration = defineAnalysisRegistration({
    ...input.configuration,
    live: input.live,
    ...(input.projectCatalogs ? { projectCatalogs: input.projectCatalogs } : {}),
  });
  if (registration.mode !== "live" || !registration.cache)
    throw new TypeError("Live sessions require a live target registration");
  if ("analyze" in input.profile) throw new TypeError("Live sessions require a lightweight profile");
  const scope = createAnalysisContextScope(input);
  const interval = input.contextIntervalMs ?? input.live.contextIntervalMs ?? 5000;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 300_000)
    throw new RangeError("Invalid live context observation interval");
  const now = input.now ?? Date.now;
  const lifetime = new AbortController();
  const pending = new Map<number, { document: string; controller: AbortController }>();
  const documents = new Map<string, { version: number; key: string }>();
  let sequence = 0,
    closed = false;
  let servicesPromise: Promise<LiveAnalysisServices> | undefined;
  let resolvedServices: LiveAnalysisServices | undefined;
  let scheduler: LiveAnalysisScheduler | undefined;
  let selected: QueryContractContext | undefined;
  let checkedAt: number | undefined;
  let contextToken: AnalysisCacheToken | undefined;
  let connection: LiveContractSessionStatus["connection"] = "unobserved";
  let observation: Promise<QueryContractContext> | undefined;
  const inspections = new Set<Promise<QueryContractContext>>();
  let factorySignal: AbortSignal | undefined;
  let contextFailure: { error: LiveContextUnavailableError; retryAt: number; attempts: number } | undefined;
  let closePromise: Promise<void> | undefined;
  const discardFailures: unknown[] = [];
  const discard = async (owned: LiveAnalysisServices) => {
    try {
      await owned.close();
    } catch (error) {
      discardFailures.push(error);
      throw error;
    }
  };
  const retry = new Map<string, { at: number; attempts: number }>();
  let captureTail = Promise.resolve();
  const capturedViews = new Map<string, { key: string; at: number; view: LiveContractView<Snapshot, Policy> }>();
  const alive = () => {
    if (closed) throw new Error("Live contract session is closed");
  };
  async function services(): Promise<LiveAnalysisServices> {
    alive();
    if (resolvedServices) return resolvedServices;
    servicesPromise ??= (async () => {
      const construction = new AbortController();
      const deadline = setTimeout(
        () => construction.abort(new Error("Live factory deadline exceeded")),
        input.live.deadlineMs ?? 5000,
      );
      const signal = AbortSignal.any([lifetime.signal, construction.signal]);
      factorySignal = signal;
      try {
        const owned = await input.live.adapter({
          schema: input.schema,
          typePolicy: input.typePolicy ?? input.profile.defaultTypePolicy,
          signal,
        });
        if (!owned || typeof owned.close !== "function") throw new TypeError("Live adapter requires owned cleanup");
        if (
          owned.connectionContext !== registration.cache!.connectionContext ||
          owned.adapter?.id !== registration.cache!.adapter.id ||
          owned.adapter.version !== registration.cache!.adapter.version ||
          canonicalContractData(owned.adapter.grammar) !== canonicalContractData(scope.grammar) ||
          owned.contribution?.id !== registration.qualification.owner.id ||
          owned.contribution.version !== registration.qualification.owner.version ||
          canonicalContractData(owned.contribution.grammar) !== canonicalContractData(scope.grammar) ||
          typeof owned.inspectContext !== "function"
        ) {
          await discard(owned);
          throw new TypeError("Live service registration differs from its target or owner");
        }
        if (signal.aborted) {
          await discard(owned);
          signal.throwIfAborted();
        }
        resolvedServices = owned;
        return owned;
      } finally {
        clearTimeout(deadline);
      }
    })();
    return untilAbort(servicesPromise, factorySignal!);
  }
  function inspect(): Promise<QueryContractContext> {
    const work = inspectContext();
    inspections.add(work);
    void work.then(
      () => inspections.delete(work),
      () => inspections.delete(work),
    );
    return work;
  }
  async function inspectContext(): Promise<QueryContractContext> {
    alive();
    let head = await input.cache.lookupContext(scope);
    lifetime.signal.throwIfAborted();
    if (
      head.recorded?.status === "stale" ||
      (contextToken && canonicalContractData(contextToken) !== canonicalContractData(head.token)) ||
      (selected && head.recorded && canonicalContractData(selected) !== canonicalContractData(head.recorded.context))
    )
      checkedAt = undefined;
    if (contextFailure && (observation || now() < contextFailure.retryAt)) throw contextFailure.error;
    if (!observation && selected && checkedAt !== undefined && now() - checkedAt < interval) return selected;
    const timeout = new AbortController();
    // A pending request owns this deadline; it must settle even when no socket or other work keeps Node alive.
    const timer = setTimeout(
      () => timeout.abort(new Error("Live context deadline exceeded")),
      input.live.deadlineMs ?? 5000,
    );
    const deadline = AbortSignal.any([lifetime.signal, timeout.signal]);
    if (observation) {
      try {
        return await untilAbort(observation, deadline);
      } finally {
        clearTimeout(timer);
      }
    }
    observation = (async () => {
      const owned = await services();
      async function remote() {
        for (let attempt = 0; ; attempt++) {
          try {
            return await owned.inspectContext(deadline);
          } catch (error) {
            deadline.throwIfAborted();
            connection = "unavailable";
            const failure = parseLiveAnalysisFailure(
              owned.classifyError?.(error) ??
                owned.adapter.classifyError?.(error) ?? {
                  kind: "unavailable",
                  code: "context-observation-failed",
                  retry: "change",
                },
            );
            if (failure.kind === "unavailable") throw new LiveContextUnavailableError(failure);
            checkedAt = undefined;
            if (failure.kind === "stale-context") {
              const prior = selected ?? head.recorded?.context ?? input.recordedContext;
              if (prior) await input.cache.retireContext(prior);
              if (attempt < 2) {
                // A failed observation grants no facts. Begin the next read with a fresh cache fence
                // after retirement, preserving any subsequent clear or competing publication.
                head = await input.cache.lookupContext(scope);
                deadline.throwIfAborted();
                continue;
              }
            }
            throw error;
          }
        }
      }
      const signal = deadline;
      const current = parseQueryContractContext(await untilAbort(remote(), signal));
      signal.throwIfAborted();
      try {
        assertContextScope(current, scope);
      } catch (error) {
        const prior = selected ?? head.recorded?.context ?? input.configuration.context ?? input.recordedContext;
        if (prior) await input.cache.retireContext(prior);
        throw error;
      }
      if (
        input.configuration.context &&
        canonicalContractData(current) !== canonicalContractData(input.configuration.context)
      ) {
        await input.cache.retireContext(input.configuration.context);
        throw namedAnalysisError("LiveContextPinError", "Live context differs from its explicit pin");
      }
      const published = await input.cache.publishContext({
        token: head.token,
        scope,
        context: current,
        ...(input.recordedContext ? { previousContext: input.recordedContext } : {}),
      });
      if (published.status !== "published")
        throw namedAnalysisError("LiveContextPublicationError", `Live context publication ${published.status}`);
      contextToken = published.token;
      const changed = selected && canonicalContractData(selected) !== canonicalContractData(current);
      selected = current;
      checkedAt = now();
      connection = "available";
      contextFailure = undefined;
      if (changed) {
        try {
          input.onContextChange?.();
        } catch {
          /* Observers cannot poison native acquisition. */
        }
      }
      return current;
    })();
    const work = observation;
    void work.then(
      () => {
        observation = undefined;
      },
      () => {
        observation = undefined;
      },
    );
    try {
      return await untilAbort(work, deadline);
    } catch (error) {
      if (lifetime.signal.aborted) throw error;
      const failure =
        error instanceof LiveContextUnavailableError
          ? error
          : deadline.aborted
            ? new LiveContextUnavailableError({ kind: "unavailable", code: "context-deadline", retry: "transport" })
            : undefined;
      if (failure) {
        connection = "unavailable";
        const attempts = (contextFailure?.attempts ?? 0) + 1;
        contextFailure = {
          error: failure,
          attempts,
          retryAt:
            failure.failure.retry === "change"
              ? Infinity
              : now() + Math.max(interval, [1000, 2000, 4000, 8000, 16000, 30000][Math.min(attempts - 1, 5)]!),
        };
        throw failure;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function sharedScheduler(options: LiveAnalysisSchedulerOptions): Promise<LiveAnalysisScheduler> {
    if (scheduler) return scheduler;
    const owned = await services();
    if (scheduler) return scheduler;
    const run = createPersistentLiveAnalysisRunner({
      cache: input.cache,
      run: createNativeLiveAnalysisRunner({
        adapter: owned.adapter,
        contribution: owned.contribution,
        ...(owned.classifyError ? { classifyError: owned.classifyError.bind(owned) } : {}),
      }),
    });
    scheduler = createLiveAnalysisScheduler({
      ...options,
      maxRecords: 256,
      maxSubscribers: 256,
      maxQueued: 16,
      run: async (request, signal) => {
        const result = await run(request, signal);
        if (result.kind === "unavailable") connection = "unavailable";
        else if (result.kind === "usable-recorded-context") connection = "available";
        const key = queryContractDigest(request);
        if (result.kind === "stale-context") {
          checkedAt = undefined;
          if (retry.size >= 256 && !retry.has(key)) retry.delete(retry.keys().next().value!);
          retry.set(key, { attempts: 0, at: now() });
        } else if (result.kind === "unavailable" && result.retry === "transport") {
          const attempts = (retry.get(key)?.attempts ?? 0) + 1;
          if (retry.size >= 256 && !retry.has(key)) retry.delete(retry.keys().next().value!);
          retry.set(key, { attempts, at: now() + [1000, 2000, 4000, 8000, 16000, 30000][Math.min(attempts - 1, 5)]! });
        } else retry.delete(key);
        return result;
      },
    });
    return scheduler;
  }
  const closeDocument = (document: string) => {
    documents.delete(document);
    capturedViews.delete(document);
    for (const [id, batch] of pending)
      if (batch.document === document) {
        batch.controller.abort(new Error("Live document changed or closed"));
        scheduler?.closeDocument(`typed-sql:session:${id}`);
      }
  };
  return Object.freeze({
    status: () =>
      Object.freeze({
        observation: "request-driven" as const,
        freshness: "unverified" as const,
        connection,
        ...(checkedAt === undefined ? {} : { lastContextCheckAt: checkedAt }),
        activePreparations: pending.size,
      }),
    closeDocument,
    async prepare(
      request: Parameters<LiveContractSession<Snapshot, Policy>["prepare"]>[0],
    ): Promise<LiveContractView<Snapshot, Policy>> {
      alive();
      if (!request.document || !Number.isSafeInteger(request.version) || request.version < 0)
        throw new TypeError("Invalid live document identity");
      if (
        request.candidates.length > 4096 ||
        request.candidates.reduce((bytes, candidate) => bytes + Buffer.byteLength(candidate.sql), 0) > 16 * 1024 * 1024
      )
        throw new RangeError("Live candidate capacity exceeded");
      if (pending.size >= 32) throw new RangeError("Live preparation capacity exceeded");
      const candidates = request.candidates.map(parseNativeContractCandidate);
      const key = queryContractDigest({ version: request.version, candidates });
      const previous = documents.get(request.document);
      if (previous && previous.version > request.version)
        throw namedAnalysisError("LiveDocumentChangedError", "Live document version is stale");
      if (previous && previous.key !== key) closeDocument(request.document);
      if (!documents.has(request.document) && documents.size >= 256) {
        const active = new Set([...pending.values()].map((batch) => batch.document));
        const oldest = [...documents.keys()].find((document) => !active.has(document));
        if (oldest === undefined) throw new RangeError("Live document capacity exceeded");
        closeDocument(oldest);
      }
      documents.delete(request.document);
      documents.set(request.document, { version: request.version, key });
      const id = ++sequence,
        controller = new AbortController();
      pending.set(id, { document: request.document, controller });
      const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(request.signal ? [request.signal] : [])]);
      const deadline = setTimeout(
        () => controller.abort(new Error("Live session batch deadline exceeded")),
        input.live.batchDeadlineMs ?? 60_000,
      );
      try {
        signal.throwIfAborted();
        const owned = await untilAbort(services(), signal);
        signal.throwIfAborted();
        if (input.projectCatalogs?.capture) {
          const before = captureTail;
          let release!: () => void;
          const done = new Promise<void>((resolve) => {
            release = resolve;
          });
          captureTail = before.then(() => done);
          try {
            await untilAbort(before, signal);
            await untilAbort(inspect(), signal);
            signal.throwIfAborted();
            const cached = capturedViews.get(request.document);
            if (cached?.key === key && now() - cached.at < interval) {
              try {
                await cached.view.assertCurrent();
                return Object.freeze({
                  ...cached.view,
                  async assertCurrent() {
                    signal.throwIfAborted();
                    await cached.view.assertCurrent();
                  },
                });
              } catch {
                signal.throwIfAborted();
                capturedViews.delete(request.document);
              }
            }
            await delay(300, undefined, { signal });
            const view = await prepareLiveContractView({
              ...input,
              candidates,
              signal,
              live: {
                ...input.live,
                adapter: () => ({
                  connectionContext: owned.connectionContext,
                  adapter: owned.adapter,
                  contribution: owned.contribution,
                  inspectContext: owned.inspectContext.bind(owned),
                  ...(owned.classifyError ? { classifyError: owned.classifyError.bind(owned) } : {}),
                  close: async () => {},
                }),
              },
            });
            const base = view.projectCatalogs!.baseContext;
            if (selected && canonicalContractData(selected) !== canonicalContractData(base)) {
              capturedViews.clear();
              try {
                input.onContextChange?.();
              } catch {
                /* Observer errors do not invalidate evidence. */
              }
            }
            selected = base;
            checkedAt = now();
            contextToken = (await input.cache.lookupContext(scope)).token;
            const assertCurrent = async () => {
              signal.throwIfAborted();
              if (closed || documents.get(request.document)?.key !== key)
                throw namedAnalysisError("LiveDocumentChangedError", "Live document view is stale");
              await view.assertCurrent();
            };
            await assertCurrent();
            const result = Object.freeze({ ...view, assertCurrent });
            capturedViews.set(request.document, { key, at: now(), view: result });
            return result;
          } finally {
            release();
          }
        }
        for (let attempt = 0; ; attempt++) {
          try {
            const queue = await sharedScheduler({
              run: async () => {
                throw new Error("Uninitialized native runner");
              },
              debounceMs: 300,
              maxActive: input.live.maxActive ?? 8,
              concurrencyPerContext: input.live.concurrencyPerContext ?? 2,
              deadlineMs: input.live.deadlineMs ?? 5000,
            });
            signal.throwIfAborted();
            const current = await inspect();
            signal.throwIfAborted();
            const capturedContextToken = contextToken!;
            const view = await prepareLiveContractViewWithScheduler(
              {
                ...input,
                configuration: { ...input.configuration, context: current },
                candidates,
                signal,
                live: {
                  ...input.live,
                  adapter: async () => ({
                    connectionContext: owned.connectionContext,
                    adapter: owned.adapter,
                    contribution: owned.contribution,
                    inspectContext: inspect,
                    ...(owned.classifyError ? { classifyError: owned.classifyError.bind(owned) } : {}),
                    close: async () => {},
                  }),
                },
              },
              () => ({
                ...queue,
                subscribe(value, listener) {
                  const requestKey = queryContractDigest(value.request),
                    due = retry.get(requestKey);
                  const subscription = queue.subscribe(
                    {
                      ...value,
                      ticket: {
                        ...value.ticket,
                        document: `typed-sql:session:${id}`,
                        documentVersion: request.version,
                      },
                    },
                    listener,
                  );
                  if (due && due.at <= now()) queue.retry(requestKey);
                  return subscription;
                },
                close: async () => {},
              }),
            );
            const tokens: AnalysisCacheToken[] = [capturedContextToken];
            for (const candidate of candidates) {
              const found = await input.cache.lookupRecorded({
                candidate,
                context: view.context,
                adapter: registration.cache!.adapter,
                connectionContext: registration.cache!.connectionContext,
                policy: registration.qualification,
              });
              const contract = view.contracts.find((contract) => contract.sqlDigest === exactSqlDigest(candidate.sql));
              if (
                contract &&
                found.cached &&
                (found.cached.outcome.kind !== "usable-recorded-context" ||
                  found.cached.outcome.contract.digest !== contract.digest)
              )
                throw namedAnalysisError("LiveQueryPublicationError", "Live query changed before view publication");
              tokens.push(found.token);
            }
            const assertCurrent = async () => {
              signal.throwIfAborted();
              if (closed || documents.get(request.document)?.key !== key)
                throw namedAnalysisError("LiveDocumentChangedError", "Live document view is stale");
              await view.assertCurrent();
              if (!(await input.cache.areTokensCurrent(tokens)))
                throw namedAnalysisError("LiveViewInvalidatedError", "Live query evidence changed");
            };
            await assertCurrent();
            return Object.freeze({ ...view, assertCurrent });
          } catch (error) {
            signal.throwIfAborted();
            if (input.configuration.context || !(error instanceof NativeContextChangedError) || attempt >= 2)
              throw error;
            checkedAt = undefined;
          }
        }
      } finally {
        clearTimeout(deadline);
        scheduler?.closeDocument(`typed-sql:session:${id}`);
        pending.delete(id);
      }
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        lifetime.abort(new Error("Live session closed"));
        await captureTail;
        await Promise.allSettled([...inspections, observation]);
        const [owned] = await Promise.allSettled([servicesPromise]);
        const cleanup = await Promise.allSettled([
          scheduler?.close(),
          owned.status === "fulfilled" ? owned.value?.close() : undefined,
        ]);
        const failures = [
          ...discardFailures,
          ...cleanup.flatMap((value) => (value.status === "rejected" ? [value.reason] : [])),
        ];
        if (failures.length) throw new AggregateError(failures, "Live session cleanup failed");
      })();
      return closePromise;
    },
  });
}
