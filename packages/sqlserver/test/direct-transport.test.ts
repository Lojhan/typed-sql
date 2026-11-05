import { describe, it, strict } from "poku";
import { type OdbcCommand, ODBC_STATE as S } from "../src/odbc-protocol.js";
import { directPortFixture as fixture } from "./helpers/direct-ports.js";

await describe("SQL Server direct ODBC parent worker ownership", async () => {
  await it("serializes requests, ignores stale replies and sends native cleanup after quarantine", async () => {
    const state = fixture();
    await state.transport.ready;
    let command: OdbcCommand | undefined;
    state.data.handler = (value) => {
      command = value as OdbcCommand;
    };
    const pending = state.transport.request({ kind: "execute", text: "SELECT 1", values: [] });
    while (!command) await Promise.resolve();
    await strict.rejects(() => state.transport.request({ kind: "execute", text: "SELECT 2", values: [] }), /busy/);
    state.data.emit("message", { id: command.id + 1 });
    strict.equal(state.transport.busy, true);
    state.data.emit("message", { id: command.id, result: { rows: [], columns: [] } });
    await pending;
    state.transport.reusable = false;
    await strict.rejects(
      () => state.transport.request({ kind: "execute", text: "SELECT 3", values: [] }),
      /quarantined/,
    );
    state.data.handler = (value) => {
      const close = value as OdbcCommand;
      queueMicrotask(() => state.data.emit("message", { id: close.id }));
    };
    await state.transport.close();
    strict.equal((state.data.messages.at(-1) as OdbcCommand).kind, "close");
    strict.equal(state.data.unrefs, 1);
    strict.equal(state.control.unrefs, 1);
  });
  await it("waits for a control ACK and frees a handle created just as cancellation wins", async () => {
    for (const kind of ["prepare", "streamStart"] as const) {
      const state = fixture(),
        controller = new AbortController();
      await state.transport.ready;
      state.control.handler = () => {};
      state.data.handler = (value) => {
        const command = value as OdbcCommand;
        queueMicrotask(() => {
          if (command.kind === kind) {
            controller.abort("late cancel");
            state.data.emit("message", { id: command.id, handle: 41 });
          } else state.data.emit("message", { id: command.id });
        });
      };
      const pending = state.transport.request(
        kind === "prepare" ? { kind, text: "SELECT 1" } : { kind, text: "SELECT 1", values: [] },
        { signal: controller.signal },
      );
      const outcome = pending.then(
        () => false,
        (error) => (error as { code?: unknown }).code === "TSQL_CANCELLED",
      );
      while (!state.control.messages.length) await Promise.resolve();
      await Promise.resolve();
      strict.equal(state.transport.busy, true);
      const cancel = state.control.messages[0] as { epoch: number };
      Atomics.store(state.words, S.ack, cancel.epoch);
      state.control.emit("message", { ack: cancel.epoch });
      strict.equal(await outcome, true);
      strict.equal((state.data.messages[1] as OdbcCommand).kind, kind === "prepare" ? "freePrepared" : "streamClose");
      strict.equal((state.data.messages[1] as { handle: number }).handle, 41);
      strict.equal(state.transport.busy, false);
      await state.transport.close();
    }
  });
  await it("keeps cleanup available after request epoch exhaustion and rejects dead-worker reuse", async () => {
    const state = fixture();
    await state.transport.ready;
    state.transport.nextId = 0x7fffffff;
    await strict.rejects(
      () => state.transport.request({ kind: "execute", text: "SELECT 1", values: [] }),
      /epoch exhausted/,
    );
    await state.transport.close();
    strict.equal((state.data.messages.at(-1) as OdbcCommand).id, 0);
    const dead = fixture();
    await dead.transport.ready;
    dead.data.emit("exit", 1);
    await strict.rejects(
      () => dead.transport.request({ kind: "execute", text: "SELECT 1", values: [] }),
      /quarantined|exited/,
    );
    await strict.rejects(() => dead.transport.close(), /exited/);
  });
  await it("fails initialization and live worker errors without exposing driver messages", async () => {
    const invalid = fixture(false);
    await strict.rejects(invalid.transport.ready, /initialization/);
    const state = fixture();
    await state.transport.ready;
    state.data.handler = () => {};
    const pending = state.transport.request({ kind: "execute", text: "SELECT private_value", values: [] });
    while (!state.data.messages.length) await Promise.resolve();
    state.control.emit("error", new Error("sensitive native driver detail"));
    await strict.rejects(
      pending,
      (error) => error instanceof Error && !error.message.includes("sensitive") && /quarantined/.test(error.message),
    );
    state.data.handler = (value) => {
      const command = value as OdbcCommand;
      queueMicrotask(() => state.data.emit("message", { id: command.id }));
    };
    await state.transport.close();
  });
});
