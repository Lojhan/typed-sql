import type { PlaygroundLimits } from "./contracts.js";
import type { ResultPaging } from "./result-store.js";
import { decodeValue, type WireValue } from "./values.js";

export interface WorkerRequest {
  readonly resultDirectory: string;
  readonly config: string;
  readonly target?: string;
  readonly entry: string;
  readonly mode: "file" | "export" | "sql";
  readonly exportName?: string;
  readonly values?: readonly WireValue[];
  readonly sql?: string;
  readonly readOnly: boolean;
  readonly limits: PlaygroundLimits;
  readonly files: readonly { readonly path: string; readonly hash: string }[];
}

export type WorkerEvent =
  | {
      readonly type: "result";
      readonly name: string;
      readonly value: WireValue;
      readonly truncated: boolean;
      readonly paging?: ResultPaging;
      readonly provenance: "managed" | "unverified";
      readonly target?: unknown;
    }
  | { readonly type: "cursor-wait" | "cursor-fetch"; readonly id: string }
  | { readonly type: "error"; readonly message: string; readonly code: string }
  | { readonly type: "local-error"; readonly message: string }
  | { readonly type: "done" };

/** Runtime IPC validation is independent of TypeScript annotations in trusted project code. */
export function validateWorkerEvent(value: unknown, maximumBytes: number): WorkerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid worker event");
  if (Buffer.byteLength(JSON.stringify(value)) > maximumBytes)
    throw new RangeError("Worker event exceeds result limits");
  const event = value as Record<string, unknown>;
  if (event.type === "done") return { type: "done" };
  if (
    ["cursor-wait", "cursor-fetch"].includes(String(event.type)) &&
    typeof event.id === "string" &&
    /^[a-f0-9-]{36}$/u.test(event.id)
  )
    return value as WorkerEvent;
  if (
    event.type === "error" &&
    typeof event.code === "string" &&
    event.code.length <= 100 &&
    typeof event.message === "string" &&
    event.message.length <= 100_000
  )
    return { type: "error", code: event.code, message: event.message };
  if (event.type === "local-error" && typeof event.message === "string" && event.message.length <= 100_000)
    return { type: "local-error", message: event.message };
  if (
    event.type === "result" &&
    typeof event.name === "string" &&
    event.name.length <= 160 &&
    typeof event.truncated === "boolean" &&
    ["managed", "unverified"].includes(String(event.provenance)) &&
    Object.hasOwn(event, "value")
  ) {
    if (event.paging !== undefined) {
      const p = event.paging as ResultPaging;
      if (
        !p ||
        !/^[a-f0-9-]{36}$/u.test(p.id) ||
        ![p.rowCount, p.pageCount, p.pageSize].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        p.pageSize < 1 ||
        typeof p.complete !== "boolean" ||
        !["database-cursor", "database-spool", "materialized"].includes(p.source)
      )
        throw new TypeError("Invalid result paging metadata");
    }
    // Check containers before passing any nested data into the browser.
    decodeValue(event.value as WireValue);
    if (event.target !== undefined) {
      const target = event.target;
      if (
        !target ||
        typeof target !== "object" ||
        !("database" in target) ||
        typeof target.database !== "string" ||
        !("server" in target) ||
        typeof target.server !== "string" ||
        !("adapter" in target) ||
        typeof target.adapter !== "string" ||
        !("readOnly" in target) ||
        typeof target.readOnly !== "boolean"
      )
        throw new TypeError("Invalid observed target metadata");
    }
    return value as WorkerEvent;
  }
  throw new TypeError("Invalid worker event envelope");
}
