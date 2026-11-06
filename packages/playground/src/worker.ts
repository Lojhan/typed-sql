import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig } from "@typed-sql/config";
import type { Database } from "@typed-sql/core";
import { register } from "tsx/esm/api";
import type { PlaygroundTarget } from "./contracts.js";
import { contentHash, WorkspaceError } from "./files.js";
import { ResultSpool } from "./result-store.js";
import { installRunRuntime } from "./runtime.js";
import { decodeValue } from "./values.js";
import type { WorkerEvent, WorkerRequest } from "./worker-protocol.js";

const send = (event: WorkerEvent) => {
  if (process.connected) process.send?.(event);
};
const controller = new AbortController();
let initialized = false;
let pull: { id: string; resume: () => void } | undefined;
process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && "cancel" in message) {
    controller.abort();
    return;
  }
  if (message && typeof message === "object" && "pull" in message) {
    const waiting = pull;
    if (waiting && message.pull === waiting.id) waiting.resume();
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
  const resultBudget = { bytes: 0 };

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
      const spool = new ResultSpool(
        request.resultDirectory,
        request.limits.pageSize ?? 200,
        request.limits.maxResultBytes,
        "materialized",
        request.limits.maxSpoolBytes,
        resultBudget,
      );
      const object =
        value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
      const allRows = Array.isArray(value) ? value : Array.isArray(object?.rows) ? object.rows : undefined;
      const limited =
        allRows !== undefined && request.limits.maxRows !== undefined && allRows.length > request.limits.maxRows;
      const rows = limited ? allRows!.slice(0, request.limits.maxRows) : allRows;
      if (rows) {
        for (let offset = 0; offset < rows.length; offset += spool.pageSize) {
          const page = rows.slice(offset, offset + spool.pageSize);
          spool.append(Array.isArray(value) ? page : { ...object, rows: page }, page.length);
        }
        if (!rows.length) spool.append(value, 0);
      } else spool.append(value, 1);
      send({
        type: "result",
        name: name.slice(0, 160),
        value: spool.first!,
        truncated: limited,
        paging: spool.metadata(!limited),
        provenance,
        ...(provenance === "managed" && identity ? { target: identity } : {}),
      });
    };
    if (request.mode === "sql") {
      if (!target || request.sql === undefined)
        throw new WorkspaceError("EXECUTION", "SQL execution requires a configured connected target");
      const spool = new ResultSpool(
        request.resultDirectory,
        request.limits.pageSize ?? 200,
        request.limits.maxResultBytes,
        request.readOnly && target.rowStreaming === true ? "database-cursor" : "database-spool",
        request.limits.maxSpoolBytes,
        resultBudget,
      );
      let limited = false;
      let fetchMs: number | undefined;
      const publish = (complete: boolean) =>
        send({
          type: "result",
          name: "Query result",
          value: spool.first!,
          truncated: limited,
          paging: spool.metadata(complete),
          ...(fetchMs === undefined ? {} : { timings: { fetchMs } }),
          provenance: "managed",
          ...(identity ? { target: identity } : {}),
        });
      const result = await target.query({
        text: request.sql,
        values: (request.values ?? []).map(decodeValue),
        readOnly: request.readOnly,
        maxRows: request.limits.maxRows ?? Number.MAX_SAFE_INTEGER,
        pageSize: request.limits.pageSize ?? 200,
        maxResultBytes: request.limits.maxResultBytes,
        timeoutMs: request.limits.timeoutMs,
        signal: controller.signal,
        cursorIdleMs: request.limits.cursorIdleMs ?? 30_000,
        onRows: async (batch) => {
          limited ||= batch.truncated;
          spool.append(batch, batch.rows.length);
          if (
            request.readOnly &&
            target!.rowStreaming === true &&
            !limited &&
            batch.rows.length === (request.limits.pageSize ?? 200)
          ) {
            // Install demand before publishing so a fast browser request cannot miss its wakeup.
            await new Promise<void>((resolve, reject) => {
              let timer: ReturnType<typeof setTimeout>;
              const cleanup = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", aborted);
                pull = undefined;
              };
              const aborted = () => {
                cleanup();
                reject(
                  new WorkspaceError(
                    "CURSOR_CLOSED",
                    "Cursor closed; captured pages are retained as incomplete evidence",
                  ),
                );
              };
              timer = setTimeout(() => controller.abort(), request.limits.cursorIdleMs ?? 30_000);
              timer.unref();
              pull = {
                id: spool.id,
                resume: () => {
                  cleanup();
                  send({ type: "cursor-fetch", id: spool.id });
                  resolve();
                },
              };
              controller.signal.addEventListener("abort", aborted, { once: true });
              if (controller.signal.aborted) aborted();
              else {
                send({ type: "cursor-wait", id: spool.id });
                publish(false);
              }
            });
          }
        },
      });
      if (!spool.pageCount) spool.append(result, result.rows.length);
      // Command metadata is authoritative only after execution and commit have completed.
      const first = decodeValue(spool.first!) as Record<string, unknown>;
      spool.finalizeFirst({ ...result, rows: first.rows });
      fetchMs = result.timings?.activeMs;
      limited ||= result.truncated;
      publish(!limited);
    } else {
      const database = target
        ? wrapDatabase(
            await target.database({
              readOnly: request.readOnly,
              maxRows: request.limits.maxRows ?? Number.MAX_SAFE_INTEGER,
              pageSize: request.limits.pageSize ?? 200,
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
    const cancellation = error instanceof Error && "code" in error && error.code === "TSQL_CANCELLED";
    const confirmedCancel = cancellation && "confirmed" in error && error.confirmed === true;
    const outcomeUnknown =
      (error instanceof Error && "outcomeUnknown" in error && error.outcomeUnknown === true) ||
      (cancellation && !confirmedCancel);
    const message = cancellation
      ? confirmedCancel
        ? "The database confirmed cancellation of the managed operation. Earlier or private effects are not undone."
        : "The managed operation stopped without confirmed database cancellation. Inspect the target before retrying."
      : error instanceof WorkspaceError || managed
        ? (error as Error).message
        : "Project execution failed. Inspect the local terminal for details.";
    await new Promise<void>((resolve) => {
      if (process.connected)
        process.send?.(
          {
            type: "error",
            message,
            code: outcomeUnknown
              ? "OUTCOME_UNKNOWN"
              : confirmedCancel
                ? "CANCELLED"
                : controller.signal.aborted
                  ? "OUTCOME_UNKNOWN"
                  : error instanceof WorkspaceError
                    ? error.code
                    : "EXECUTION",
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
