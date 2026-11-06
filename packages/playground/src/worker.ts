import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig } from "@typed-sql/config";
import type { Database } from "@typed-sql/core";
import { register } from "tsx/esm/api";
import type { PlaygroundTarget } from "./contracts.js";
import { contentHash, WorkspaceError } from "./files.js";
import { installRunRuntime } from "./runtime.js";
import { decodeValue, encodeValue } from "./values.js";
import type { WorkerEvent, WorkerRequest } from "./worker-protocol.js";

const send = (event: WorkerEvent) => {
  if (process.connected) process.send?.(event);
};
const controller = new AbortController();
let initialized = false;
process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && "cancel" in message) {
    controller.abort();
    return;
  }
  if (initialized) return;
  initialized = true;
  void run(message as WorkerRequest);
});

async function run(request: WorkerRequest): Promise<void> {
  let notifyImport: (url: string) => void = () => undefined;
  const loader = register({ namespace: `playground-${randomUUID()}`, onImport: (url) => notifyImport(url) });
  let target: PlaygroundTarget | undefined;
  let uninstall: (() => void) | undefined;
  let count = 0;
  let totalBytes = 0;
  const pending = new Set<Promise<unknown>>();
  const wrapDatabase = (database: Database): Database =>
    new Proxy(database, {
      get(object, property) {
        const value: unknown = Reflect.get(object, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "transaction" && typeof args[0] === "function") {
            const callback = args[0];
            args[0] = (tx: Database) => Reflect.apply(callback, undefined, [wrapDatabase(tx)]);
          }
          const result: unknown = Reflect.apply(value, object, args);
          if (!(result instanceof Promise)) return result;
          pending.add(result);
          void result.finally(() => pending.delete(result)).catch(() => undefined);
          return result;
        };
      },
    });
  try {
    for (const file of request.files) {
      if (contentHash(await readFile(file.path, "utf8")) !== file.hash)
        throw new WorkspaceError("STALE_SOURCE", "Run inputs changed before config loading; run again");
    }
    const loaded = await loadConfig({
      file: request.config,
      importer: async (file, onImport) => {
        notifyImport = onImport;
        const result: unknown = await loader.import(pathToFileURL(file).href, import.meta.url);
        return result as { readonly default?: unknown };
      },
    });
    for (const file of request.files) {
      if (contentHash(await readFile(file.path, "utf8")) !== file.hash)
        throw new WorkspaceError("EXECUTION", "Run inputs changed after checking; save and run again");
    }
    const selected = request.target === undefined ? undefined : loaded.config.playground?.targets?.[request.target];
    if (request.target !== undefined && !selected)
      throw new WorkspaceError("EXECUTION", "Selected playground target is not configured");
    if (selected?.classification === "production" && request.mode !== "sql")
      throw new WorkspaceError("EXECUTION", "Trusted TypeScript execution is disabled on production targets");
    if (selected) {
      const candidate = await selected.connect();
      if (
        !candidate ||
        typeof candidate !== "object" ||
        !("query" in candidate) ||
        !("database" in candidate) ||
        !("close" in candidate) ||
        !("identity" in candidate)
      )
        throw new WorkspaceError("EXECUTION", "Configured target does not implement the playground service contract");
      if (
        !["identity", "query", "database", "close"].every(
          (method) => typeof Reflect.get(candidate, method) === "function",
        )
      )
        throw new WorkspaceError("TARGET", "Target service methods must be callable");
      target = candidate as PlaygroundTarget;
      const identity = await target.identity();
      if (selected.expected?.database !== undefined && selected.expected.database !== identity.database)
        throw new WorkspaceError("EXECUTION", "Observed database does not match the expected target identity");
    }
    const identity = await target?.identity();
    const emit = (name: string, value: unknown, provenance: "managed" | "unverified" = "unverified") => {
      if (++count > 10) throw new WorkspaceError("EXECUTION", "A run can emit at most 10 result sets");
      let truncated = false;
      if (Array.isArray(value) && value.length > request.limits.maxRows) {
        value = value.slice(0, request.limits.maxRows);
        truncated = true;
      }
      const encoded = encodeValue(value, { maxBytes: request.limits.maxResultBytes - totalBytes });
      totalBytes += Buffer.byteLength(JSON.stringify(encoded));
      if (totalBytes > request.limits.maxResultBytes)
        throw new WorkspaceError("EXECUTION", "Result payload exceeds the configured byte limit; narrow the query");
      send({
        type: "result",
        name: name.slice(0, 160),
        value: encoded,
        truncated,
        provenance,
        ...(provenance === "managed" && identity ? { target: identity } : {}),
      });
    };
    if (request.mode === "sql") {
      if (!target || request.sql === undefined)
        throw new WorkspaceError("EXECUTION", "SQL execution requires a configured connected target");
      const result = await target.query({
        text: request.sql,
        values: (request.values ?? []).map(decodeValue),
        readOnly: request.readOnly,
        maxRows: request.limits.maxRows,
        maxResultBytes: request.limits.maxResultBytes,
        timeoutMs: request.limits.timeoutMs,
        signal: controller.signal,
      });
      emit("Query result", result, "managed");
    } else {
      const database = target
        ? wrapDatabase(
            await target.database({
              readOnly: request.readOnly,
              maxRows: request.limits.maxRows,
              maxResultBytes: request.limits.maxResultBytes,
              timeoutMs: request.limits.timeoutMs,
              signal: controller.signal,
            }),
          )
        : undefined;
      uninstall = installRunRuntime({ database, emit });
      const module: Record<string, unknown> = await loader.import(pathToFileURL(request.entry).href, import.meta.url);
      if (request.mode === "export") {
        const fn = module[request.exportName ?? "run"];
        if (typeof fn !== "function" || fn.length !== 0)
          throw new WorkspaceError("EXECUTION", "Select a statically declared zero-argument exported function");
        emit(request.exportName ?? "run", await Reflect.apply(fn, undefined, []));
      }
      if (pending.size > 0) {
        await Promise.allSettled([...pending]);
        throw new WorkspaceError(
          "EXECUTION",
          "Task returned with unawaited managed database operations. Await every query before returning.",
        );
      }
    }
    uninstall?.();
    uninstall = undefined;
    await target?.close();
    target = undefined;
    await new Promise<void>((resolve) => {
      if (process.connected) process.send?.({ type: "done" }, () => resolve());
      else resolve();
    });
  } catch (error) {
    send({ type: "local-error", message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    const managed = error instanceof Error && error.name === "PlaygroundPgError";
    const message =
      error instanceof WorkspaceError || managed
        ? (error as Error).message
        : "Project execution failed. Inspect the local terminal for details.";
    const confirmedCancel = error instanceof Error && "code" in error && error.code === "TSQL_CANCELLED";
    await new Promise<void>((resolve) => {
      if (process.connected)
        process.send?.(
          {
            type: "error",
            message,
            code: confirmedCancel ? "CANCELLED" : controller.signal.aborted ? "OUTCOME_UNKNOWN" : "EXECUTION",
          },
          () => resolve(),
        );
      else resolve();
    });
  } finally {
    uninstall?.();
    await target
      ?.close()
      .catch((error) => send({ type: "local-error", message: `Target cleanup failed: ${String(error)}` }));
    await loader.unregister();
    process.disconnect?.();
    // Trusted files may leave timers or servers alive. Their lifetime ends with this run.
    process.exit(0);
  }
}
