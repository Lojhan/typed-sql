const { MessageChannel, receiveMessageOnPort, Worker } =
  require("node:worker_threads") as typeof import("node:worker_threads");
const { join } = require("node:path") as typeof import("node:path");

import type { BuildDiagnostic, BuildResult } from "./engine.js";
import type { BuildOptions } from "./project.js";

interface Response {
  ok: boolean;
  value?: unknown;
  error?: { message: string; diagnostics?: BuildDiagnostic[] };
}

/** Synchronous Jest callers still use the same async config loader and compiler in an owned worker. */
class SynchronousSession {
  readonly #worker: import("node:worker_threads").Worker;
  readonly #port: import("node:worker_threads").MessagePort;
  readonly #state = new Int32Array(new SharedArrayBuffer(4));
  readonly #options: BuildOptions;
  readonly #timeout: number;
  #closed = false;
  constructor(options: BuildOptions) {
    this.#options = options;
    this.#options = options;
    this.#timeout = options.timeoutMs ?? 30_000;
    const { port1, port2 } = new MessageChannel();
    this.#port = port1;
    this.#worker = new Worker(
      __filename.endsWith(".cts")
        ? join(__dirname, "../dist/packages/build/src/worker.js")
        : join(__dirname, "worker.js"),
      { execArgv: [], workerData: { port: port2, signal: this.#state.buffer }, transferList: [port2] },
    );
    this.#worker.on("error", () => this.close());
    this.#worker.unref();
    this.#port.unref();
  }
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#port.close();
      void this.#worker.terminate();
    }
  }
  request(operation: "identity", source?: string, id?: string): { key: string; dependencies: readonly string[] };
  request(operation: "transform", source: string, id: string): BuildResult | null;
  request(
    operation: "javascript",
    source: string,
    id: string,
    format: "esm" | "cjs",
  ): { code: string; map: import("./engine.js").BuildSourceMap };
  request(
    operation: "identity" | "transform" | "javascript",
    source?: string,
    id?: string,
    format?: "esm" | "cjs",
  ): unknown {
    if (this.#closed) throw new Error("The typed-sql transformer worker is closed");
    Atomics.store(this.#state, 0, 0);
    this.#port.postMessage({ operation, options: this.#options, source, id, format });
    const started = Date.now();
    if (Atomics.wait(this.#state, 0, 0, this.#timeout) === "timed-out") {
      this.close();
      throw new Error(`typed-sql build configuration/compilation exceeded ${this.#timeout}ms`);
    }
    let response = receiveMessageOnPort(this.#port)?.message as Response | undefined;
    while (response === undefined && Date.now() - started < this.#timeout) {
      Atomics.wait(this.#state, 0, 1, 1);
      response = receiveMessageOnPort(this.#port)?.message as Response | undefined;
    }
    if (response === undefined) {
      this.close();
      throw new Error("typed-sql transformer worker returned no result");
    }
    if (!response.ok)
      throw Object.assign(new Error(response.error?.message ?? "typed-sql compilation failed"), {
        name: response.error?.diagnostics === undefined ? "Error" : "BuildError",
        code: "TYPED_SQL_BUILD",
        diagnostics: response.error?.diagnostics,
      });
    return response.value;
  }
}

export = SynchronousSession;
