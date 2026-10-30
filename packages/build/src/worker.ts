import { type MessagePort, parentPort, workerData } from "node:worker_threads";

const { port, signal } = workerData as { port: MessagePort; signal: SharedArrayBuffer };
const state = new Int32Array(signal);
let session: import("./engine.js").BuildSession | undefined;
port.on(
  "message",
  async (request: {
    operation: "identity" | "transform" | "javascript";
    options: import("./project.js").BuildOptions;
    source?: string;
    id?: string;
    format?: "esm" | "cjs";
  }) => {
    try {
      const { BuildSession } = await import("./engine.js");
      session ??= new BuildSession(request.options);
      let value: unknown;
      if (request.operation === "identity") value = await session.identity();
      else {
        const result = await session.transform(request.source!, request.id!);
        if (request.operation === "javascript") {
          const { identityMap, javascript } = await import("./maps.js");
          value = await javascript(
            result?.code ?? request.source!,
            request.id!,
            result?.map ?? identityMap(request.source!, request.id!),
            request.format,
          );
        } else value = result;
      }
      port.postMessage({ ok: true, value });
    } catch (error) {
      port.postMessage({
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          diagnostics:
            error !== null && typeof error === "object" && "diagnostics" in error ? error.diagnostics : undefined,
        },
      });
    } finally {
      Atomics.store(state, 0, 1);
      Atomics.notify(state, 0);
    }
  },
);
parentPort?.on("close", () => port.close());
