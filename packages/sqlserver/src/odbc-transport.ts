import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { type ExecutionOptions, runControlledExecution } from "@typed-sql/core";
import {
  type OdbcCommand,
  type OdbcReply,
  type OdbcWorkerOptions,
  odbcState,
  ODBC_STATE as S,
} from "./odbc-protocol.js";
export type OdbcWorkerPort = {
  [Key in "on" | "once" | "off" | "postMessage" | "unref"]: (...args: Parameters<Worker[Key]>) => unknown;
};
export type OdbcWorkerFactory = (url: URL, role: "control" | "data", options: OdbcWorkerOptions) => OdbcWorkerPort;
type CommandBody = OdbcCommand extends infer Command
  ? Command extends OdbcCommand
    ? Omit<Command, "id">
    : never
  : never;
export class SqlServerOdbcTransport {
  readonly state;
  readonly control: OdbcWorkerPort;
  readonly data: OdbcWorkerPort;
  readonly ready: Promise<void>;
  nextId = 1;
  busy = false;
  closed = false;
  reusable = true;
  cursor: number | undefined;
  private dataExited = false;
  private readonly acknowledgements = new Map<number, () => void>();
  private pending: { id: number; resolve(reply: OdbcReply): void; reject(error: unknown): void } | undefined;
  constructor(
    readonly options: OdbcWorkerOptions,
    factory: OdbcWorkerFactory = (url, role, options) => new Worker(url, { workerData: { role, options } }),
  ) {
    this.state = odbcState(options.shared);
    const sibling = new URL("./odbc-worker.js", import.meta.url),
      url = existsSync(sibling) ? sibling : new URL("../dist/packages/sqlserver/src/odbc-worker.js", import.meta.url);
    this.control = factory(url, "control", options);
    this.data = factory(url, "data", options);
    const start = (worker: OdbcWorkerPort) =>
      new Promise<void>((resolve, reject) => {
        const listener = (message: { ready?: boolean; error?: unknown }) => {
          if (message.ready === undefined) return;
          worker.off("message", listener);
          if (message.ready) resolve();
          else reject(new Error("SQL Server ODBC worker initialization failed"));
        };
        worker.on("message", listener);
        worker.once("error", () => reject(new Error("SQL Server ODBC worker initialization failed")));
        worker.once("exit", () => reject(new Error("SQL Server ODBC worker exited during initialization")));
      });
    this.ready = Promise.all([start(this.control), start(this.data)]).then(() => {});
    void this.ready.catch(() => {
      this.reusable = false;
      this.control.postMessage({ kind: "close" });
      this.data.postMessage({ id: 0, kind: "close" });
      this.control.unref();
      this.data.unref();
    });
    this.data.on("message", (reply: OdbcReply) => {
      if (!Number.isInteger(reply.id) || reply.id !== this.pending?.id) return;
      const pending = this.pending;
      this.pending = undefined;
      if (reply.error) {
        if (!reply.error.reusable) this.reusable = false;
        const error = new Error(reply.error.message);
        Object.assign(error, {
          code: "TSQL_ODBC_NATIVE",
          stage: reply.error.stage,
          diagnostics: reply.error.diagnostics,
        });
        pending.reject(error);
      } else pending.resolve(reply);
    });
    this.control.on("message", (message: { ack?: number; failed?: boolean }) => {
      if (message.failed) this.reusable = false;
      if (message.ack !== undefined) {
        this.acknowledgements.get(message.ack)?.();
        this.acknowledgements.delete(message.ack);
      }
    });
    const failed = () => {
      this.reusable = false;
      Atomics.store(this.state.words, S.controlFailure, 1);
      Atomics.notify(this.state.words, S.ack);
      Atomics.notify(this.state.words, S.borrows);
      this.pending?.reject(new Error("SQL Server ODBC worker failed; connection quarantined"));
      this.pending = undefined;
      for (const resolve of this.acknowledgements.values()) resolve();
      this.acknowledgements.clear();
    };
    this.control.on("error", failed);
    this.data.on("error", failed);
    this.control.on("exit", () => {
      if (!this.closed) failed();
    });
    this.data.on("exit", () => {
      this.dataExited = true;
      if (!this.closed) failed();
    });
  }
  async request(command: CommandBody, controls: ExecutionOptions = {}, cursor?: number): Promise<OdbcReply> {
    await this.ready;
    if (this.closed || (!this.reusable && !["close", "freePrepared", "streamClose"].includes(command.kind)))
      throw new Error("SQL Server direct ODBC connection is closed or quarantined");
    if (this.busy || (this.cursor !== undefined && this.cursor !== cursor))
      throw new Error("SQL Server direct ODBC connection is busy");
    const cleanup = ["close", "freePrepared", "streamClose"].includes(command.kind);
    if (this.dataExited) throw new Error("SQL Server ODBC data worker exited; native cleanup is unconfirmed");
    if (this.nextId >= 0x7fffffff && !cleanup)
      throw new RangeError("SQL Server ODBC request epoch exhausted; recreate the connection");
    this.busy = true;
    const id = this.nextId >= 0x7fffffff ? 0 : this.nextId++;
    let created: OdbcReply | undefined,
      cancelled = false;
    try {
      return await runControlledExecution(
        controls,
        () =>
          new Promise<OdbcReply>((resolve, reject) => {
            this.pending = {
              id,
              resolve: (reply) => {
                created = reply;
                resolve(reply);
              },
              reject,
            };
            this.data.postMessage({ ...command, id });
          }),
        () => {
          cancelled = true;
          Atomics.store(this.state.words, S.cancel, id);
          this.control.postMessage({ kind: "cancel", epoch: id });
        },
      );
    } finally {
      if (
        Atomics.load(this.state.words, S.cancel) === id &&
        Atomics.load(this.state.words, S.ack) !== id &&
        !Atomics.load(this.state.words, S.controlFailure)
      )
        await new Promise<void>((resolve) => {
          this.acknowledgements.set(id, resolve);
          if (Atomics.load(this.state.words, S.ack) === id) {
            this.acknowledgements.delete(id);
            resolve();
          }
        });
      if (cancelled && created?.handle !== undefined && ["prepare", "streamStart"].includes(command.kind)) {
        const cleanupId = this.nextId++;
        try {
          await new Promise<OdbcReply>((resolve, reject) => {
            this.pending = { id: cleanupId, resolve, reject };
            this.data.postMessage({
              id: cleanupId,
              kind: command.kind === "prepare" ? "freePrepared" : "streamClose",
              handle: created!.handle,
            });
          });
        } catch {
          this.reusable = false;
        }
      }
      this.busy = false;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.busy || this.cursor !== undefined) throw new Error("Cannot close an active direct ODBC connection");
    try {
      await this.request({ kind: "close" });
    } finally {
      this.closed = true;
      this.reusable = false;
      this.control.postMessage({ kind: "close" });
      this.control.unref();
      this.data.unref();
    }
  }
}
