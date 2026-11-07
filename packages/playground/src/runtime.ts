import type { Database } from "@typed-sql/core";

export interface RunRuntime {
  readonly database: Database | undefined;
  readonly emit: (name: string, value: unknown) => void;
}
const key = Symbol.for("@typed-sql/playground/runtime/v1");
const globals = globalThis as typeof globalThis & { [key]?: RunRuntime };

/** Server-only helper, pinned to the worker's selected target for this run. */
export function databaseForRun(): Database {
  const database = globals[key]?.database;
  if (!database) throw new Error("Run this file through typed-sql playground with an explicit configured target");
  return database;
}

/** Emit a named result. Values are bounded and encoded by the active worker. */
export function show(name: string, value: unknown): void {
  const runtime = globals[key];
  if (!runtime) throw new Error("show() is only available inside an active typed-sql playground run");
  runtime.emit(name, value);
}

/** @internal Worker bootstrap; not re-exported from the main entrypoint. */
export function installRunRuntime(runtime: RunRuntime): () => void {
  if (globals[key]) throw new Error("A playground runtime is already active");
  globals[key] = runtime;
  return () => {
    delete globals[key];
  };
}
