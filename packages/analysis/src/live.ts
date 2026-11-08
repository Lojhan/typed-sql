import { acquireNativeQueryContract, type NativeContractAdapter } from "./acquisition.js";
import { type NativeContractCandidate, parseNativeContractCandidate } from "./candidate.js";
import { canonicalContractData, exactSqlDigest, queryContractDigest } from "./canonical.js";
import { createQueryContractIndex, type QueryContract } from "./contracts.js";
import { type ContractQualificationPolicy, parseContractQualificationPolicy } from "./qualification-model.js";
import {
  type ContractReconciliationContribution,
  parseStaticQueryClaim,
  reconcileQueryContract,
  type StaticQueryClaim,
} from "./reconciliation.js";
import { parseRecordedQueryContract } from "./recorded-query.js";

export interface LiveAnalysisRequest {
  readonly connectionContext: string;
  readonly adapter: { readonly id: string; readonly version: string };
  readonly candidate: NativeContractCandidate;
  readonly staticClaim: StaticQueryClaim;
  readonly policy: ContractQualificationPolicy;
}
export interface LiveAnalysisGenerations {
  readonly inputGeneration: number;
  readonly contextGeneration: number;
  readonly policyGeneration: number;
}
export interface LiveAnalysisTicket extends LiveAnalysisGenerations {
  readonly document: string;
  readonly documentVersion: number;
}
export type LiveAnalysisFailure =
  | { readonly kind: "partial" | "rejected" | "conflict" | "stale-context"; readonly code: string }
  | { readonly kind: "unavailable"; readonly code: string; readonly retry: "transport" | "change" };
export type LiveAnalysisOutcome =
  | { readonly kind: "usable-recorded-context"; readonly contract: QueryContract }
  | LiveAnalysisFailure;
export type LiveAnalysisState = LiveAnalysisOutcome | { readonly kind: "pending" } | { readonly kind: "stale-input" };
export type LiveAnalysisRunner = (request: LiveAnalysisRequest, signal: AbortSignal) => Promise<LiveAnalysisOutcome>;
export interface LiveAnalysisClock {
  now(): number;
  random(): number;
  after(milliseconds: number, callback: () => void): () => void;
}
export interface LiveAnalysisView {
  readonly generation: number;
  readonly contracts: readonly QueryContract[];
}
export interface LiveAnalysisSchedulerOptions {
  readonly run: LiveAnalysisRunner;
  readonly clock?: LiveAnalysisClock;
  readonly debounceMs?: number;
  readonly deadlineMs?: number;
  readonly concurrencyPerContext?: number;
  readonly maxActive?: number;
  readonly maxQueued?: number;
  readonly maxRecords?: number;
  readonly maxSubscribers?: number;
  readonly onView?: (view: LiveAnalysisView) => void;
  readonly onObserverError?: (error: unknown) => void;
}
export interface LiveAnalysisSubscription {
  readonly key: string;
  readonly state: LiveAnalysisState;
  cancel(): void;
}
export interface LiveAnalysisScheduler {
  readonly view: LiveAnalysisView;
  readonly generations: LiveAnalysisGenerations;
  subscribe(
    input: { readonly ticket: LiveAnalysisTicket; readonly queryId: string; readonly request: LiveAnalysisRequest },
    listener: (state: LiveAnalysisState) => void,
  ): LiveAnalysisSubscription;
  closeDocument(document: string): void;
  advance(next: LiveAnalysisGenerations): void;
  retry(key: string): void;
  close(): Promise<void>;
}
interface Subscriber {
  readonly slot: string;
  readonly ticket: LiveAnalysisTicket;
  readonly record: RecordState;
  readonly listener: (state: LiveAnalysisState) => void;
  active: boolean;
  lastDelivery?: LiveAnalysisState;
}
interface Operation {
  readonly controller: AbortController;
  obsolete: boolean;
  expired: boolean;
}
interface RecordState {
  readonly key: string;
  readonly request: LiveAnalysisRequest;
  readonly subscribers: Set<Subscriber>;
  state: LiveAnalysisState;
  lastGood?: QueryContract;
  operation?: Operation;
  queued: boolean;
  queuedAt: number;
  due: boolean;
  cancelTimer?: () => void;
  failures: number;
  touched: number;
}
const defaultClock: LiveAnalysisClock = {
  now: Date.now,
  random: Math.random,
  after(milliseconds, callback) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 4096)
    throw new TypeError("Invalid live analysis identifier");
}
function generations(value: LiveAnalysisGenerations): void {
  for (const key of ["inputGeneration", "contextGeneration", "policyGeneration"] as const)
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new TypeError("Invalid live analysis generation");
}
export function parseLiveAnalysisRequest(input: LiveAnalysisRequest): LiveAnalysisRequest {
  const value: LiveAnalysisRequest = JSON.parse(canonicalContractData(input));
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "adapter,candidate,connectionContext,policy,staticClaim" ||
    !/^[a-f0-9]{64}$/u.test(value.connectionContext)
  )
    throw new TypeError("Invalid live analysis request");
  text(value.adapter?.id);
  text(value.adapter?.version);
  if (Object.keys(value.adapter).sort().join(",") !== "id,version")
    throw new TypeError("Invalid live adapter identity");
  const candidate = parseNativeContractCandidate(value.candidate),
    staticClaim = parseStaticQueryClaim(value.staticClaim),
    policy = parseContractQualificationPolicy(value.policy);
  if (exactSqlDigest(candidate.sql) !== staticClaim.sqlDigest)
    throw new TypeError("Live candidate/static query identity differs");
  return Object.freeze({ ...value, adapter: Object.freeze(value.adapter), candidate, staticClaim, policy });
}
export function parseLiveAnalysisOutcome(
  input: LiveAnalysisOutcome,
  expected: LiveAnalysisRequest,
): LiveAnalysisOutcome {
  if (input.kind === "usable-recorded-context") {
    const contract = parseRecordedQueryContract(input.contract, {
      candidate: expected.candidate,
      context: expected.staticClaim.context,
      policy: expected.policy,
      adapter: expected.adapter,
      connectionContext: expected.connectionContext,
    });
    if (contract.qualification!.staticClaimHash !== expected.staticClaim.digest)
      throw new TypeError("Live contract does not match the requested static claim");
    return Object.freeze({ kind: input.kind, contract });
  }
  return parseLiveAnalysisFailure(input);
}
export function parseLiveAnalysisFailure(input: unknown): LiveAnalysisFailure {
  const value = JSON.parse(canonicalContractData(input));
  if (
    !value ||
    !["partial", "rejected", "conflict", "stale-context", "unavailable"].includes(value.kind) ||
    typeof value.code !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value.code) ||
    Object.keys(value).sort().join(",") !== (value.kind === "unavailable" ? "code,kind,retry" : "code,kind") ||
    (value.kind === "unavailable" && !["transport", "change"].includes(value.retry))
  )
    throw new TypeError("Invalid live analysis outcome");
  return Object.freeze(value);
}
/** Explicit async host producer shared by live queues and batch hosts; no grammar-ID dispatch. */
export function createNativeLiveAnalysisRunner(input: {
  readonly adapter: NativeContractAdapter;
  readonly contribution: ContractReconciliationContribution;
  readonly classifyError?: (error: unknown) => LiveAnalysisFailure;
}): LiveAnalysisRunner {
  return async (request, signal) => {
    try {
      if (input.adapter.id !== request.adapter.id || input.adapter.version !== request.adapter.version)
        throw new TypeError("Live adapter registration differs");
      const acquired = await acquireNativeQueryContract({
        adapter: input.adapter,
        candidate: request.candidate,
        context: request.staticClaim.context,
        signal,
      });
      if (acquired.status !== "acquired")
        return acquired.reason === "context-changed" || acquired.reason === "context-mismatch"
          ? { kind: "stale-context", code: acquired.reason }
          : { kind: "partial", code: acquired.reason };
      const reconciled = reconcileQueryContract({
        nativeContract: acquired.contract,
        staticClaim: request.staticClaim,
        contribution: input.contribution,
        policy: request.policy,
      });
      return reconciled.status === "qualified"
        ? { kind: "usable-recorded-context", contract: reconciled.contract }
        : {
            kind: reconciled.status === "conflict" ? "conflict" : "partial",
            code: `reconciliation-${reconciled.status}`,
          };
    } catch (error) {
      signal.throwIfAborted();
      return input.classifyError?.(error) ?? { kind: "unavailable", code: "native-runner-error", retry: "change" };
    }
  };
}

/** One explicitly enabled project queue. It never mutates source SQL or durable exports. */
export function createLiveAnalysisScheduler(options: LiveAnalysisSchedulerOptions): LiveAnalysisScheduler {
  const clock = options.clock ?? defaultClock;
  const limits = {
    debounceMs: options.debounceMs ?? 300,
    deadlineMs: options.deadlineMs ?? 5000,
    concurrencyPerContext: options.concurrencyPerContext ?? 2,
    maxActive: options.maxActive ?? 8,
    maxQueued: options.maxQueued ?? 16,
    maxRecords: options.maxRecords ?? 256,
    maxSubscribers: options.maxSubscribers ?? 256,
  };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < (name === "debounceMs" ? 0 : 1) || value > 1_000_000)
      throw new RangeError("Invalid live analysis limit");
  const records = new Map<string, RecordState>(),
    subscribers = new Map<string, Subscriber>(),
    documents = new Map<string, number>(),
    activeContexts = new Map<string, number>();
  let epoch: LiveAnalysisGenerations = { inputGeneration: 0, contextGeneration: 0, policyGeneration: 0 },
    sequence = 0,
    active = 0,
    closed = false,
    flushQueued = false;
  let view: LiveAnalysisView = Object.freeze({ generation: 0, contracts: Object.freeze([]) });
  const waiters = new Set<() => void>();
  const current = (subscriber: Subscriber) =>
    subscriber.active &&
    documents.get(subscriber.ticket.document) === subscriber.ticket.documentVersion &&
    subscriber.ticket.inputGeneration === epoch.inputGeneration &&
    subscriber.ticket.contextGeneration === epoch.contextGeneration &&
    subscriber.ticket.policyGeneration === epoch.policyGeneration;
  const observe = (callback: () => void) => {
    try {
      callback();
    } catch (error) {
      try {
        options.onObserverError?.(error);
      } catch {
        /* Observers cannot strand leases or poison other subscribers. */
      }
    }
  };
  let notifiedGeneration = 0;
  const refreshView = () => {
    const contracts = [...records.values()]
      .filter((record) => [...record.subscribers].some(current) && record.lastGood)
      .map((record) => record.lastGood!);
    let next: readonly QueryContract[];
    try {
      const unique = new Map(contracts.map((contract) => [contract.digest, contract]));
      next = [...unique.values()].sort((left, right) => left.digest.localeCompare(right.digest));
      createQueryContractIndex(next);
    } catch {
      for (const record of records.values())
        if (record.lastGood) {
          delete record.lastGood;
          record.state = Object.freeze({ kind: "conflict", code: "active-contract-conflict" });
        }
      next = [];
    }
    if (
      canonicalContractData(view.contracts.map((item) => item.digest)) !==
      canonicalContractData(next.map((item) => item.digest))
    ) {
      view = Object.freeze({ generation: view.generation + 1, contracts: Object.freeze(next) });
    }
  };
  const flush = () => {
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      refreshView();
      if (notifiedGeneration !== view.generation) {
        notifiedGeneration = view.generation;
        observe(() => options.onView?.(view));
      }
      for (const subscriber of [...subscribers.values()])
        if (current(subscriber) && subscriber.lastDelivery !== subscriber.record.state) {
          subscriber.lastDelivery = subscriber.record.state;
          observe(() => subscriber.listener(subscriber.record.state));
        }
    });
  };
  const trim = () => {
    const unused = [...records.values()]
      .filter((record) => !record.subscribers.size && !record.operation)
      .sort((left, right) => left.touched - right.touched);
    while (records.size > limits.maxRecords && unused.length) {
      const record = unused.shift()!;
      record.cancelTimer?.();
      records.delete(record.key);
    }
  };
  const detach = (subscriber: Subscriber) => {
    subscriber.active = false;
    subscribers.delete(subscriber.slot);
    subscriber.record.subscribers.delete(subscriber);
    if (!subscriber.record.subscribers.size) {
      subscriber.record.cancelTimer?.();
      delete subscriber.record.cancelTimer;
      subscriber.record.queued = false;
      if (subscriber.record.operation) {
        subscriber.record.operation.obsolete = true;
        subscriber.record.operation.controller.abort();
      }
    }
  };
  const queue = (record: RecordState, delay: number) => {
    record.cancelTimer?.();
    record.state = Object.freeze({ kind: "pending" });
    record.queued = true;
    record.queuedAt = ++sequence;
    record.due = delay === 0;
    if (delay)
      record.cancelTimer = clock.after(delay, () => {
        delete record.cancelTimer;
        record.due = true;
        pump();
      });
    pump();
    const queued = [...records.values()]
      .filter((item) => item.queued)
      .sort((left, right) => left.queuedAt - right.queuedAt);
    if (queued.length > limits.maxQueued) {
      const evicted = queued[0]!;
      evicted.cancelTimer?.();
      delete evicted.cancelTimer;
      evicted.queued = false;
      delete evicted.lastGood;
      evicted.state = Object.freeze({ kind: "unavailable", code: "queue-limit", retry: "change" });
    }
    flush();
  };
  const install = (record: RecordState, value: LiveAnalysisOutcome) => {
    record.state = Object.freeze(value);
    if (value.kind === "usable-recorded-context") {
      record.lastGood = value.contract;
      record.failures = 0;
    } else if (value.kind !== "unavailable" || value.retry !== "transport") delete record.lastGood;
    if (value.kind === "unavailable" && value.retry === "transport" && record.subscribers.size) {
      const seconds = [1, 2, 4, 8, 16, 30][Math.min(record.failures++, 5)]!;
      let random = 0.5;
      try {
        const sampled = clock.random();
        if (Number.isFinite(sampled) && sampled >= 0 && sampled <= 1) random = sampled;
      } catch {
        /* A broken jitter source must not strand an expired adapter lease. */
      }
      record.cancelTimer = clock.after(Math.round(seconds * 1000 * (0.8 + 0.4 * random)), () => {
        delete record.cancelTimer;
        if (record.subscribers.size) queue(record, 0);
      });
    }
    flush();
  };
  const start = (record: RecordState) => {
    record.cancelTimer?.();
    delete record.cancelTimer;
    record.queued = false;
    const operation: Operation = { controller: new AbortController(), obsolete: false, expired: false };
    record.operation = operation;
    active++;
    const context = record.request.connectionContext;
    activeContexts.set(context, (activeContexts.get(context) ?? 0) + 1);
    const valid = () =>
      !closed && !operation.obsolete && records.get(record.key) === record && [...record.subscribers].some(current);
    const cancelDeadline = clock.after(limits.deadlineMs, () => {
      if (!valid()) return;
      operation.expired = true;
      operation.controller.abort();
      install(record, { kind: "unavailable", code: "native-deadline", retry: "transport" });
    });
    void (async () => {
      try {
        const result = await options.run(record.request, operation.controller.signal);
        if (valid() && !operation.expired) install(record, parseLiveAnalysisOutcome(result, record.request));
      } catch {
        if (valid() && !operation.expired)
          install(record, { kind: "unavailable", code: "live-runner-error", retry: "change" });
      } finally {
        cancelDeadline();
        if (record.operation === operation) delete record.operation;
        active--;
        const count = (activeContexts.get(context) ?? 1) - 1;
        if (count) activeContexts.set(context, count);
        else activeContexts.delete(context);
        trim();
        pump();
        if (closed && !active) {
          for (const resolve of waiters) resolve();
          waiters.clear();
        }
      }
    })();
  };
  function pump() {
    if (closed) return;
    for (const record of [...records.values()].sort((left, right) => left.queuedAt - right.queuedAt))
      if (
        active < limits.maxActive &&
        record.queued &&
        record.due &&
        !record.operation &&
        record.subscribers.size &&
        (activeContexts.get(record.request.connectionContext) ?? 0) < limits.concurrencyPerContext
      )
        start(record);
  }
  return Object.freeze({
    get view(): LiveAnalysisView {
      refreshView();
      return view;
    },
    get generations(): LiveAnalysisGenerations {
      return Object.freeze({ ...epoch });
    },
    subscribe(
      input: { readonly ticket: LiveAnalysisTicket; readonly queryId: string; readonly request: LiveAnalysisRequest },
      listener: (state: LiveAnalysisState) => void,
    ) {
      if (closed) throw new Error("Live analysis scheduler is closed");
      const ticket = JSON.parse(canonicalContractData(input.ticket)) as LiveAnalysisTicket;
      generations(ticket);
      text(ticket.document);
      text(input.queryId);
      if (!Number.isSafeInteger(ticket.documentVersion) || ticket.documentVersion < 0)
        throw new TypeError("Invalid document version");
      const captured = Object.freeze(ticket),
        normalized = parseLiveAnalysisRequest(input.request),
        key = queryContractDigest(normalized),
        slot = canonicalContractData([ticket.document, input.queryId]);
      const version = documents.get(ticket.document);
      if (
        (version !== undefined && ticket.documentVersion < version) ||
        ticket.inputGeneration !== epoch.inputGeneration ||
        ticket.contextGeneration !== epoch.contextGeneration ||
        ticket.policyGeneration !== epoch.policyGeneration
      )
        return Object.freeze({
          key,
          get state(): LiveAnalysisState {
            return { kind: "stale-input" };
          },
          cancel() {},
        });
      if (version === undefined && documents.size >= limits.maxSubscribers)
        throw new RangeError("Live analysis document limit");
      if (version !== ticket.documentVersion) {
        documents.set(ticket.document, ticket.documentVersion);
        for (const subscriber of [...subscribers.values()])
          if (subscriber.ticket.document === ticket.document) detach(subscriber);
      }
      const previous = subscribers.get(slot);
      if (previous) {
        if (previous.record.key === key && current(previous)) {
          previous.active = false;
          previous.record.subscribers.delete(previous);
          subscribers.delete(slot);
        } else detach(previous);
      }
      if (subscribers.size >= limits.maxSubscribers) throw new RangeError("Live analysis subscriber limit");
      let record = records.get(key);
      if (!record) {
        record = {
          key,
          request: normalized,
          subscribers: new Set(),
          state: Object.freeze({ kind: "pending" }),
          queued: false,
          queuedAt: 0,
          due: false,
          failures: 0,
          touched: ++sequence,
        };
        records.set(key, record);
      }
      record.touched = ++sequence;
      const subscriber: Subscriber = {
        slot,
        ticket: captured,
        record,
        listener,
        active: true,
        ...(previous?.record.key === key && previous.lastDelivery ? { lastDelivery: previous.lastDelivery } : {}),
      };
      record.subscribers.add(subscriber);
      subscribers.set(slot, subscriber);
      if (
        (record.state.kind === "pending" && !record.queued && !record.operation) ||
        record.operation?.obsolete ||
        (record.state.kind === "unavailable" && record.state.code === "queue-limit")
      )
        queue(record, limits.debounceMs);
      else flush();
      trim();
      return Object.freeze({
        key,
        get state(): LiveAnalysisState {
          return current(subscriber) ? record.state : { kind: "stale-input" };
        },
        cancel() {
          if (subscriber.active) {
            detach(subscriber);
            trim();
            flush();
            pump();
          }
        },
      });
    },
    closeDocument(document: string) {
      for (const subscriber of [...subscribers.values()])
        if (subscriber.ticket.document === document) detach(subscriber);
      documents.delete(document);
      trim();
      flush();
      pump();
    },
    advance(next: LiveAnalysisGenerations) {
      generations(next);
      for (const key of ["inputGeneration", "contextGeneration", "policyGeneration"] as const)
        if (next[key] < epoch[key]) throw new TypeError("Live analysis generations cannot move backwards");
      if (canonicalContractData(next) === canonicalContractData(epoch)) return;
      epoch = Object.freeze({ ...next });
      for (const subscriber of [...subscribers.values()]) detach(subscriber);
      for (const record of records.values()) {
        record.cancelTimer?.();
        if (record.operation) {
          record.operation.obsolete = true;
          record.operation.controller.abort();
        }
      }
      records.clear();
      flush();
    },
    retry(key: string) {
      const record = records.get(key);
      if (!closed && record?.subscribers.size && !record.operation) {
        record.failures = 0;
        queue(record, 0);
      }
    },
    close(): Promise<void> {
      closed = true;
      for (const subscriber of [...subscribers.values()]) detach(subscriber);
      for (const record of records.values()) {
        record.cancelTimer?.();
        if (record.operation) {
          record.operation.obsolete = true;
          record.operation.controller.abort();
        }
      }
      records.clear();
      flush();
      return active ? new Promise((resolve) => waiters.add(resolve)) : Promise.resolve();
    },
  });
}
