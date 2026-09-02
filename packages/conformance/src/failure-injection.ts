export const INJECTED_FAILURE_CODE = "TSQL_CONFORMANCE_INJECTED_FAILURE" as const;

export interface FailureInjection {
  readonly point: string;
  readonly occurrence?: number;
  readonly message?: string;
}

export interface FailureInjectionSnapshot {
  readonly hits: Readonly<Record<string, number>>;
  readonly remaining: readonly FailureInjection[];
}

export class ConformanceInjectedFailure extends Error {
  readonly code = INJECTED_FAILURE_CODE;
  readonly point: string;
  readonly occurrence: number;

  constructor(point: string, occurrence: number, message?: string) {
    super(message ?? `Injected conformance failure at ${point} occurrence ${occurrence}`);
    this.name = "ConformanceInjectedFailure";
    this.point = point;
    this.occurrence = occurrence;
  }
}

export interface FailureInjector {
  readonly hit: (point: string) => void;
  readonly run: <Value>(point: string, operation: () => Value) => Value;
  readonly runAsync: <Value>(point: string, operation: () => Promise<Value>) => Promise<Value>;
  readonly snapshot: () => FailureInjectionSnapshot;
}

export function createFailureInjector(injections: readonly FailureInjection[]): FailureInjector {
  const scheduled = injections.map((injection) => {
    if (typeof injection.point !== "string" || injection.point.length === 0)
      throw new TypeError("Failure injection point must be a non-empty string");
    const occurrence = injection.occurrence ?? 1;
    if (!Number.isSafeInteger(occurrence) || occurrence < 1)
      throw new TypeError("Failure injection occurrence must be a positive safe integer");
    return Object.freeze({ ...injection, occurrence });
  });
  const hits = new Map<string, number>();
  const consumed = new Set<number>();
  const hit = (point: string): void => {
    const occurrence = (hits.get(point) ?? 0) + 1;
    hits.set(point, occurrence);
    for (const [index, injection] of scheduled.entries()) {
      if (consumed.has(index) || injection.point !== point || injection.occurrence !== occurrence) continue;
      consumed.add(index);
      throw new ConformanceInjectedFailure(point, occurrence, injection.message);
    }
  };
  return Object.freeze({
    hit,
    run<Value>(point: string, operation: () => Value): Value {
      hit(point);
      return operation();
    },
    async runAsync<Value>(point: string, operation: () => Promise<Value>): Promise<Value> {
      hit(point);
      return operation();
    },
    snapshot(): FailureInjectionSnapshot {
      return Object.freeze({
        hits: Object.freeze(Object.fromEntries([...hits].sort(([left], [right]) => left.localeCompare(right)))),
        remaining: Object.freeze(scheduled.filter((_injection, index) => !consumed.has(index))),
      });
    },
  });
}
