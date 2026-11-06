import { describe, it, strict } from "poku";
import { createPgPlaygroundTarget } from "../src/pg.js";

await describe("explicit PostgreSQL playground adapter", async () => {
  await it("is lazy and validates limits without opening a database", async () => {
    let connections = 0;
    const target = createPgPlaygroundTarget({
      connectionString: () => {
        connections++;
        return "postgres://invalid";
      },
    });
    await strict.rejects(
      () =>
        target.query({
          text: "select 1",
          values: [],
          readOnly: true,
          maxRows: 0,
          timeoutMs: 1000,
          signal: new AbortController().signal,
        }),
      /maxRows/,
    );
    await strict.rejects(
      () =>
        target.query({
          text: "select 1",
          values: [],
          readOnly: true,
          maxRows: 1,
          timeoutMs: 0,
          signal: new AbortController().signal,
        }),
      /timeoutMs/,
    );
    strict.equal(connections, 0);
    await target.close();
    await strict.rejects(() => target.identity(), /closed/);
  });

  await it("rejects transaction/session commands before accessing credentials", async () => {
    let connections = 0;
    const target = createPgPlaygroundTarget({
      connectionString: () => {
        connections++;
        throw new Error("do not connect");
      },
    });
    const request = { values: [], readOnly: true, maxRows: 10, timeoutMs: 1000, signal: new AbortController().signal };
    for (const text of [
      "COMMIT",
      "/* nested /* c */ */ SET TRANSACTION READ WRITE",
      "-- c\nROLLBACK",
      "COPY accounts TO STDOUT",
      "/* unterminated",
    ]) {
      await strict.rejects(() => target.query({ ...request, text }), /Managed execution/);
    }
    await strict.rejects(() => target.query({ ...request, text: "delete from accounts" }), /write execution mode/);
    strict.equal(connections, 0);
    await target.close();
  });

  await it("does not dispatch an already cancelled request", async () => {
    let connections = 0;
    const target = createPgPlaygroundTarget({
      connectionString: () => {
        connections++;
        throw new Error("do not connect");
      },
    });
    const controller = new AbortController();
    controller.abort();
    await strict.rejects(
      () =>
        target.query({
          text: "select 1",
          values: [],
          readOnly: true,
          maxRows: 10,
          timeoutMs: 1000,
          signal: controller.signal,
        }),
      /cancelled/,
    );
    strict.equal(connections, 0);
    await target.close();
  });
});
