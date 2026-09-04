export interface Deferred<Value> {
  readonly promise: Promise<Value>;
  reject(reason: unknown): void;
  resolve(value: Value): void;
}

/** Deterministically hold a fake operation until the test chooses success or failure. */
export function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
