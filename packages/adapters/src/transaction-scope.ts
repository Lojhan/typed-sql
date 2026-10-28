import type { QueryExecutor } from "@typed-sql/core";
import { type BufferedDatabase, type BufferedOptions, createBufferedDatabase } from "./index.js";

/** Retire callback scopes and drain already-dispatched work before a driver commits/releases. */
export function transactionScope(executor: QueryExecutor, options: BufferedOptions) {
  const base = createBufferedDatabase(executor, options);
  const pending = new Set<Promise<unknown>>();
  let active = true;
  let failure: { error: unknown } | undefined;
  const track = <T>(run: () => Promise<T>): Promise<T> => {
    if (!active) return Promise.reject(new Error("Transaction scope is no longer active"));
    const operation = run();
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      (error: unknown) => {
        pending.delete(operation);
        failure ??= { error };
      },
    );
    return operation;
  };
  const database: BufferedDatabase = {
    executionCapabilities: base.executionCapabilities,
    execute: (query) => track(() => base.execute(query)),
    all: (query, controls) => track(() => base.all(query, controls)),
    one: (query, controls) => track(() => base.one(query, controls)),
    maybeOne: (query, controls) => track(() => base.maybeOne(query, controls)),
  };
  return {
    database: Object.freeze(database),
    async finish() {
      active = false;
      await Promise.allSettled([...pending]);
      if (failure !== undefined) throw failure.error;
    },
  };
}
