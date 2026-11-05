import { createRequire } from "node:module";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  loadOdbcFunctions,
  type OdbcFunctions,
  OdbcNative,
  OdbcNativeError,
  requireSqlServerKoffi,
} from "./odbc-native.js";
import {
  ODBC_PHASE,
  type OdbcCommand,
  type OdbcReply,
  type OdbcWorkerOptions,
  odbcState,
  ODBC_STATE as S,
} from "./odbc-protocol.js";
import { OdbcSession } from "./odbc-session.js";
export function cancelOdbcEpoch(options: OdbcWorkerOptions, epoch: number, functions?: OdbcFunctions): void {
  const koffi = requireSqlServerKoffi(createRequire(import.meta.url)(options.modulePath)),
    api = functions ?? loadOdbcFunctions(koffi, options.libraryPath),
    { words, handle } = odbcState(options.shared);
  try {
    while (Atomics.load(words, S.epoch) === epoch && Atomics.load(words, S.phase) === ODBC_PHASE.native) {
      Atomics.add(words, S.borrows, 1);
      try {
        if (Atomics.load(words, S.epoch) !== epoch || Atomics.load(words, S.phase) !== ODBC_PHASE.native) break;
        const rc = api.SQLCancelHandle!(Atomics.load(words, S.kind), Atomics.load(handle, 0));
        if (rc !== 0 && rc !== 1) Atomics.store(words, S.cancelFailure, 1);
      } finally {
        Atomics.sub(words, S.borrows, 1);
        Atomics.notify(words, S.borrows);
      }
      Atomics.wait(words, S.phase, ODBC_PHASE.native, 10);
    }
  } finally {
    Atomics.store(words, S.ack, epoch);
    Atomics.notify(words, S.ack);
  }
}
export function odbcWorkerFailure(error: unknown): NonNullable<OdbcReply["error"]> {
  return error instanceof OdbcNativeError
    ? { message: error.message, stage: error.stage, diagnostics: error.diagnostics, reusable: error.reusable }
    : { message: "SQL Server native ODBC worker failed", stage: "worker", reusable: false };
}
if (!isMainThread && parentPort) {
  const data = workerData as { role: "data" | "control"; options: OdbcWorkerOptions },
    port = parentPort;
  try {
    if (data.role === "control") {
      const api = loadOdbcFunctions(
        requireSqlServerKoffi(createRequire(import.meta.url)(data.options.modulePath)),
        data.options.libraryPath,
      );
      port.on("message", (message: { kind: "cancel" | "close"; epoch?: number }) => {
        if (message.kind === "close") {
          port.close();
          return;
        }
        try {
          cancelOdbcEpoch(data.options, message.epoch!, api);
        } catch {
          const { words } = odbcState(data.options.shared);
          Atomics.store(words, S.controlFailure, 1);
          Atomics.notify(words, S.ack);
        }
      });
      port.postMessage({ ready: true });
    } else {
      const koffi = requireSqlServerKoffi(createRequire(import.meta.url)(data.options.modulePath)),
        session = new OdbcSession(new OdbcNative(koffi, data.options));
      session.open();
      port.on("message", (command: OdbcCommand) => {
        let reply: OdbcReply;
        try {
          reply = session.command(command);
        } catch (error) {
          const failure = odbcWorkerFailure(error);
          reply = { id: command.id, error: { ...failure, reusable: failure.reusable && session.native.reusable } };
        }
        port.postMessage(reply);
        if (command.kind === "close" && !reply.error) port.close();
      });
      port.postMessage({ ready: true });
    }
  } catch (error) {
    port.postMessage({ ready: false, error: odbcWorkerFailure(error) });
    port.close();
  }
}
