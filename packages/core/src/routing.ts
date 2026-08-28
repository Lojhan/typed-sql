import { type ExecutionCapabilities, type ExecutionOptions, QueryCancelledError } from "./execution.js";
import type { Database, Query } from "./query.js";
import { type QuerySemantics, unknownQuerySemantics } from "./semantics.js";

export type QueryRoute = "primary" | "replica";
export type QueryRoutePreference = "auto" | QueryRoute;

export interface QuerySemanticResolver {
  resolve<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): QuerySemantics;
}

export interface QueryRouteSelection {
  readonly preference: QueryRoutePreference;
  readonly route: QueryRoute;
  readonly primaryPinned: boolean;
  readonly semantics: QuerySemantics;
}

export interface QueryRoutingObserver {
  route(selection: QueryRouteSelection): void;
}

export interface ReplicaSelectionContext {
  readonly replicaCount: number;
  readonly roundRobinIndex: number;
  readonly semantics: QuerySemantics;
}

export type ReplicaSelector = (context: ReplicaSelectionContext) => number;

export interface TransactionRetryContext {
  /** One-based attempt that just failed. */
  readonly attempt: number;
  readonly maximumAttempts: number;
  readonly error: unknown;
}

export interface TransactionRetryEvent extends TransactionRetryContext {
  readonly delayMilliseconds: number;
}

export interface TransactionRetryPolicy {
  /** Total attempts, including the first transaction. */
  readonly maximumAttempts: number;
  /** Adapter-owned classifiers should inspect stable native error codes, never message text. */
  readonly classify: (error: unknown) => boolean;
  readonly backoff?: (context: TransactionRetryContext) => number;
  readonly signal?: AbortSignal;
  /** Injectable for deterministic clocks. The default wait is abortable. */
  readonly sleep?: (delayMilliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly onRetry?: (event: TransactionRetryEvent) => void;
}

export interface RoutedTransactionOptions {
  readonly retry?: TransactionRetryPolicy;
}

export interface RoutedDatabase extends Database<RoutedDatabase> {
  /** Creates an isolated read-after-write pinning context. */
  context(): RoutedDatabase;
  /** Returns a view with an explicit routing preference in the same context. */
  withRoute(preference: QueryRoutePreference): RoutedDatabase;
  /** Pins this context to primary before any work is dispatched. */
  pinPrimary(): void;
  transaction<T>(fn: (database: RoutedDatabase) => Promise<T>, options?: RoutedTransactionOptions): Promise<T>;
}

export interface RoutedDatabaseOptions {
  readonly primary: Database;
  readonly replicas?: readonly Database[];
  readonly semantics: QuerySemanticResolver;
  readonly selectReplica?: ReplicaSelector;
  readonly observer?: QueryRoutingObserver;
}

export class UnsafeReplicaRoutingError extends Error {
  readonly code = "TSQL_UNSAFE_REPLICA_ROUTE";
  readonly reason: "query-not-replica-safe" | "primary-pinned" | "replica-unavailable";

  constructor(reason: UnsafeReplicaRoutingError["reason"]) {
    super(
      reason === "query-not-replica-safe"
        ? "The query is not proven safe for replica execution"
        : reason === "primary-pinned"
          ? "This routing context is pinned to primary"
          : "No replica is configured for this routed database",
    );
    this.name = "UnsafeReplicaRoutingError";
    this.reason = reason;
  }
}

const unknownRange = Object.freeze({ start: 0, end: 0, line: 1, column: 1 });
const unresolvedSemantics = unknownQuerySemantics(unknownRange, "The runtime semantic resolver failed closed.");
const maximumTimerDelayMilliseconds = 2_147_483_647;

/** Returns the only safe automatic route supported by the neutral semantic contract. */
export function queryRoute(semantics: QuerySemantics): QueryRoute {
  return semantics.operation.value === "read" &&
    (semantics.volatility.value === "immutable" || semantics.volatility.value === "stable") &&
    semantics.locking.value === "none" &&
    semantics.connectionAffinity.value === "none"
    ? "replica"
    : "primary";
}

function capabilities(databases: readonly Database[]): ExecutionCapabilities {
  return Object.freeze({
    cancellation: databases.every((database) => database.executionCapabilities.cancellation),
    deadlines: databases.every((database) => database.executionCapabilities.deadlines),
  });
}

function abortError(signal: AbortSignal): QueryCancelledError {
  return new QueryCancelledError("signal", { cause: signal.reason });
}

function defaultSleep(delayMilliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (delayMilliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMilliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal!));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function validateRetryPolicy(policy: TransactionRetryPolicy): void {
  if (!Number.isSafeInteger(policy.maximumAttempts) || policy.maximumAttempts < 1) {
    throw new TypeError("Transaction retry maximumAttempts must be a positive safe integer");
  }
  if (typeof policy.classify !== "function") throw new TypeError("Transaction retry classify must be a function");
  for (const [name, value] of [
    ["backoff", policy.backoff],
    ["sleep", policy.sleep],
    ["onRetry", policy.onRetry],
  ] as const) {
    if (value !== undefined && typeof value !== "function") {
      throw new TypeError(`Transaction retry ${name} must be a function`);
    }
  }
}

function retryDelay(policy: TransactionRetryPolicy, context: TransactionRetryContext): number {
  const delay = policy.backoff?.(context) ?? 0;
  if (!Number.isFinite(delay) || delay < 0 || delay > maximumTimerDelayMilliseconds) {
    throw new RangeError(
      `Transaction retry backoff must return finite milliseconds between 0 and ${maximumTimerDelayMilliseconds}`,
    );
  }
  return delay;
}

interface RoutingState {
  primaryPinned: boolean;
}

interface SharedRoutingState {
  roundRobinIndex: number;
}

class RoutedDatabaseImplementation implements RoutedDatabase {
  readonly #primary: Database;
  readonly #replicas: readonly Database[];
  readonly #semantics: QuerySemanticResolver;
  readonly #selectReplica: ReplicaSelector | undefined;
  readonly #observer: QueryRoutingObserver | undefined;
  readonly #state: RoutingState;
  readonly #shared: SharedRoutingState;
  readonly #preference: QueryRoutePreference;
  readonly #databaseErrors: WeakSet<object> | undefined;
  readonly executionCapabilities: ExecutionCapabilities;

  constructor(
    options: RoutedDatabaseOptions,
    state: RoutingState,
    shared: SharedRoutingState,
    preference: QueryRoutePreference,
    databaseErrors?: WeakSet<object>,
  ) {
    this.#primary = options.primary;
    this.#replicas = Object.freeze([...(options.replicas ?? [])]);
    this.#semantics = options.semantics;
    this.#selectReplica = options.selectReplica;
    this.#observer = options.observer;
    this.#state = state;
    this.#shared = shared;
    this.#preference = preference;
    this.#databaseErrors = databaseErrors;
    this.executionCapabilities = capabilities([this.#primary, ...this.#replicas]);
  }

  context(): RoutedDatabase {
    return this.#view({ primaryPinned: false }, "auto");
  }

  withRoute(preference: QueryRoutePreference): RoutedDatabase {
    if (!(preference === "auto" || preference === "primary" || preference === "replica")) {
      throw new TypeError("Query route preference must be auto, primary, or replica");
    }
    return this.#view(this.#state, preference);
  }

  pinPrimary(): void {
    this.#state.primaryPinned = true;
  }

  async execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> {
    return this.#dispatch(query, (database) => database.execute(query));
  }

  async all<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<readonly Row[]> {
    return this.#dispatch(query, (database) => database.all(query, options));
  }

  async one<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<Row> {
    return this.#dispatch(query, (database) => database.one(query, options));
  }

  async maybeOne<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<Row | undefined> {
    return this.#dispatch(query, (database) => database.maybeOne(query, options));
  }

  async transaction<T>(
    fn: (database: RoutedDatabase) => Promise<T>,
    options: RoutedTransactionOptions = {},
  ): Promise<T> {
    this.pinPrimary();
    const policy = options.retry;
    if (policy !== undefined) validateRetryPolicy(policy);
    const maximumAttempts = policy?.maximumAttempts ?? 1;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      if (policy?.signal?.aborted) throw abortError(policy.signal);
      const databaseErrors = new WeakSet<object>();
      let callbackStarted = false;
      let callbackCompleted = false;
      try {
        return await this.#primary.transaction(async (transaction) => {
          callbackStarted = true;
          const scope = new RoutedDatabaseImplementation(
            {
              primary: transaction,
              semantics: this.#semantics,
              ...(this.#observer === undefined ? {} : { observer: this.#observer }),
            },
            { primaryPinned: true },
            this.#shared,
            "auto",
            databaseErrors,
          );
          const result = await fn(scope);
          callbackCompleted = true;
          return result;
        });
      } catch (error) {
        const databaseFailure =
          !callbackStarted ||
          callbackCompleted ||
          (typeof error === "object" && error !== null && databaseErrors.has(error));
        if (policy === undefined || attempt >= maximumAttempts || !databaseFailure || !policy.classify(error)) {
          throw error;
        }
        const context = Object.freeze({ attempt, maximumAttempts, error });
        const delayMilliseconds = retryDelay(policy, context);
        try {
          policy.onRetry?.(Object.freeze({ ...context, delayMilliseconds }));
        } catch {
          /* Retry observation must not replace the transaction result. */
        }
        await (policy.sleep ?? defaultSleep)(delayMilliseconds, policy.signal);
      }
    }
    throw new Error("Transaction retry exhausted without a result");
  }

  #view(state: RoutingState, preference: QueryRoutePreference, primary: Database = this.#primary): RoutedDatabase {
    return new RoutedDatabaseImplementation(
      {
        primary,
        replicas: this.#replicas,
        semantics: this.#semantics,
        ...(this.#selectReplica === undefined ? {} : { selectReplica: this.#selectReplica }),
        ...(this.#observer === undefined ? {} : { observer: this.#observer }),
      },
      state,
      this.#shared,
      preference,
      this.#databaseErrors,
    );
  }

  #resolve<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): QuerySemantics {
    try {
      return this.#semantics.resolve(query);
    } catch {
      return unresolvedSemantics;
    }
  }

  #target<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Database {
    const semantics = this.#resolve(query);
    const automatic = queryRoute(semantics);
    if (this.#preference === "replica" && automatic !== "replica") {
      throw new UnsafeReplicaRoutingError("query-not-replica-safe");
    }
    if (this.#preference === "replica" && this.#state.primaryPinned) {
      throw new UnsafeReplicaRoutingError("primary-pinned");
    }
    const requested = this.#preference === "auto" ? automatic : this.#preference;
    const route = this.#state.primaryPinned ? "primary" : requested;
    if (route === "replica" && this.#replicas.length === 0) {
      if (this.#preference === "replica") throw new UnsafeReplicaRoutingError("replica-unavailable");
      this.#notify({ preference: this.#preference, route: "primary", primaryPinned: false, semantics });
      return this.#primary;
    }
    if (route === "primary") {
      if (automatic === "primary" || this.#preference === "primary") this.pinPrimary();
      this.#notify({ preference: this.#preference, route, primaryPinned: this.#state.primaryPinned, semantics });
      return this.#primary;
    }
    const roundRobinIndex = this.#shared.roundRobinIndex++;
    const selected =
      this.#selectReplica?.({ replicaCount: this.#replicas.length, roundRobinIndex, semantics }) ??
      roundRobinIndex % this.#replicas.length;
    if (!Number.isSafeInteger(selected) || selected < 0 || selected >= this.#replicas.length) {
      throw new RangeError("Replica selector returned an invalid replica index");
    }
    this.#notify({ preference: this.#preference, route, primaryPinned: false, semantics });
    return this.#replicas[selected]!;
  }

  async #dispatch<Row, Params extends readonly unknown[], Result>(
    query: Query<Row, Params>,
    operation: (database: Database) => Promise<Result>,
  ): Promise<Result> {
    const target = this.#target(query);
    try {
      return await operation(target);
    } catch (error) {
      if (typeof error === "object" && error !== null) this.#databaseErrors?.add(error);
      throw error;
    }
  }

  #notify(selection: QueryRouteSelection): void {
    try {
      this.#observer?.route(Object.freeze(selection));
    } catch {
      /* Routing observation must not replace database execution. */
    }
  }
}

/** Composes application-owned primary/replica databases without creating pools or health policy. */
export function createRoutedDatabase(options: RoutedDatabaseOptions): RoutedDatabase {
  if (options.replicas?.some((replica) => replica === options.primary)) {
    throw new TypeError("The primary database cannot also be configured as a replica");
  }
  if (typeof options.semantics?.resolve !== "function") {
    throw new TypeError("A routed database requires a semantic resolver");
  }
  if (options.selectReplica !== undefined && typeof options.selectReplica !== "function") {
    throw new TypeError("selectReplica must be a function");
  }
  if (options.observer !== undefined && typeof options.observer.route !== "function") {
    throw new TypeError("Routing observer must provide route()");
  }
  return new RoutedDatabaseImplementation(options, { primaryPinned: false }, { roundRobinIndex: 0 }, "auto");
}
