import { describe, it, strict } from "poku";
import { idColumn, nativeApiFixture } from "./helpers/direct-api.js";

await describe("SQL Server data worker statement and retained-memory protocol", async () => {
  await it("opens an ODBC3 connection and drains command stages around one complete rowset", () => {
    const state = nativeApiFixture();
    state.session.open();
    state.plans.push([
      { columns: [], rows: [] },
      { columns: [idColumn], rows: [["1"], ["2"]] },
      { columns: [], rows: [] },
    ]);
    const result = state.session.command({ id: 1, kind: "execute", text: "command plus SELECT", values: [] });
    strict.deepEqual(result.result?.rows, [["1"], ["2"]]);
    strict.equal(state.session.owned.size, 0);
    state.plans.push([{ columns: [], rows: [] }]);
    strict.deepEqual(state.session.command({ id: 2, kind: "execute", text: "command", values: [] }).result?.rows, []);
    state.session.close();
    state.session.close();
    strict.equal(state.calls.filter((call) => call.name === "SQLDisconnect").length, 1);
  });
  await it("rebinds one prepared statement through short, long, empty, NULL and long values with fixed MAX targets", () => {
    const state = nativeApiFixture();
    state.session.open();
    const prepared = state.session.command({ id: 1, kind: "prepare", text: "SELECT bound" });
    let id = 2;
    for (const value of ["short", "é\0😀".repeat(10), "", null, "larger".repeat(10)]) {
      state.plans.push([{ columns: [idColumn], rows: [["1"]] }]);
      strict.deepEqual(
        state.session.command({ id: id++, kind: "preparedExecute", handle: prepared.handle!, values: [value] }).result
          ?.rows,
        [["1"]],
      );
      strict.equal(state.allocations.filter((pointer) => !pointer.freed).length, 2);
    }
    strict.equal(state.calls.filter((call) => call.name === "SQLPrepareW").length, 1);
    strict.equal(
      state.calls
        .filter((call) => call.name === "SQLBindParameter")
        .every((call) => call.args[4] === -9 && call.args[5] === 0),
      true,
    );
    state.session.command({ id: id++, kind: "freePrepared", handle: prepared.handle! });
    strict.equal(
      state.allocations.every((pointer) => pointer.freed),
      true,
    );
    state.session.command({ id: id++, kind: "freePrepared", handle: prepared.handle! });
    state.session.close();
  });
  await it("reuses a prepared stream handle, fetches bounded batches and closes its retained bindings", () => {
    const state = nativeApiFixture();
    state.session.open();
    const prepared = state.session.command({ id: 1, kind: "prepare", text: "SELECT stream" });
    state.plans.push([{ columns: [idColumn], rows: [["1"], ["2"], ["3"]] }]);
    const stream = state.session.command({
      id: 2,
      kind: "streamStart",
      handle: prepared.handle!,
      text: "SELECT stream",
      values: ["parameter"],
    });
    strict.equal(stream.handle, prepared.handle);
    const first = state.session.command({ id: 3, kind: "streamNext", handle: stream.handle!, batchSize: 2 }),
      second = state.session.command({ id: 4, kind: "streamNext", handle: stream.handle!, batchSize: 2 });
    strict.deepEqual(first.result?.rows, [["1"], ["2"]]);
    strict.equal(first.done, false);
    strict.deepEqual(second.result?.rows, [["3"]]);
    strict.equal(second.done, true);
    state.session.command({ id: 5, kind: "streamClose", handle: stream.handle! });
    strict.equal(
      state.allocations.every((pointer) => pointer.freed),
      true,
    );
    state.session.close();
  });
  await it("uses prepared parameter execution for ordinary binds and refuses extra result sets", () => {
    const state = nativeApiFixture();
    state.session.open();
    state.plans.push([{ columns: [idColumn], rows: [["1"]] }]);
    state.session.command({ id: 1, kind: "execute", text: "SELECT bound", values: ["1"] });
    strict.equal(
      state.allocations.every((pointer) => pointer.freed),
      true,
    );
    state.plans.push([
      { columns: [idColumn], rows: [["1"]] },
      { columns: [idColumn], rows: [["2"]] },
    ]);
    strict.throws(
      () => state.session.command({ id: 2, kind: "execute", text: "SELECT twice", values: [] }),
      /multiple-result/,
    );
    strict.equal(state.session.owned.size, 0);
    state.session.close();
  });
  await it("enforces row and cell bounds before returning buffered rows and recovers the session", () => {
    for (const options of [{ maximumRows: 1 }, { maximumCellBytes: 2 }]) {
      const state = nativeApiFixture(options);
      state.session.open();
      state.plans.push([{ columns: [idColumn], rows: options.maximumRows ? [["1"], ["2"]] : [["12345"]] }]);
      strict.throws(
        () => state.session.command({ id: 1, kind: "execute", text: "SELECT too much", values: [] }),
        /bound|limit/,
      );
      strict.equal(state.session.owned.size, 0);
      strict.deepEqual(
        state.session.command({ id: 2, kind: "execute", text: "SELECT valid", values: [] }).result?.rows,
        [["1"]],
      );
      state.session.close();
    }
  });
  await it("does not retry failed SQL and retires empty/invalid metadata or handle states", () => {
    const state = nativeApiFixture();
    state.session.open();
    state.failed.set("SQLExecute", 1);
    strict.throws(() => state.session.command({ id: 1, kind: "execute", text: "INSERT", values: ["1"] }), /execute/);
    strict.equal(state.calls.filter((call) => call.name === "SQLExecute").length, 1);
    strict.equal(
      state.allocations.every((pointer) => pointer.freed),
      true,
    );
    strict.throws(
      () => state.session.command({ id: 2, kind: "preparedExecute", handle: 999, values: [] }),
      /unknown-prepared/,
    );
    strict.throws(
      () => state.session.command({ id: 3, kind: "streamNext", handle: 999, batchSize: 1 }),
      /unknown-stream/,
    );
    state.plans.push([{ columns: [idColumn, idColumn], rows: [] }]);
    strict.throws(
      () => state.session.command({ id: 4, kind: "execute", text: "SELECT duplicate", values: [] }),
      /duplicate-column/,
    );
    state.session.close();
  });
  await it("rejects startup failures and preserves connection ownership when disconnect fails", () => {
    const invalid = nativeApiFixture({ connectionString: "bad\0connection" });
    strict.throws(() => invalid.session.open(), /connection-string/);
    strict.equal(
      invalid.calls.some((call) => call.name === "SQLFreeHandle"),
      true,
    );
    const state = nativeApiFixture();
    state.session.open();
    state.failed.set("SQLDisconnect", 1);
    strict.throws(() => state.session.close(), /disconnect/);
    strict.notEqual(state.session.connection, 0n);
    strict.equal(
      state.calls.some((call) => call.name === "SQLFreeHandle" && call.args[0] === 2),
      false,
    );
  });
  await it("rejects malformed physical metadata before retrieving any cells", () => {
    for (const column of [
      { ...idColumn, name: "" },
      { ...idColumn, name: "x".repeat(129) },
      { ...idColumn, typeName: "" },
      { ...idColumn, typeName: "sql_variant" },
      { ...idColumn, size: 0.5 },
    ]) {
      const state = nativeApiFixture();
      state.session.open();
      state.plans.push([{ columns: [column], rows: [["1"]] }]);
      strict.throws(() => state.session.command({ id: 1, kind: "execute", text: "SELECT malformed", values: [] }));
      strict.equal(
        state.calls.some((call) => call.name === "SQLGetData"),
        false,
      );
      strict.equal(state.session.owned.size, 0);
      state.session.close();
    }
  });
  await it("allows only qualified harmless login notices and quarantines transport failures", () => {
    const state = nativeApiFixture();
    state.setDiagnostic("01000", 5701);
    state.native.api.SQLDriverConnectW = () => 1;
    state.session.open();
    state.session.close();
    const invalid = nativeApiFixture();
    invalid.setDiagnostic("01004", 5701);
    invalid.native.api.SQLDriverConnectW = () => 1;
    strict.throws(() => invalid.session.open(), /connect/);
    strict.equal(
      invalid.calls.some((call) => call.name === "SQLDisconnect"),
      true,
    );
    const broken = nativeApiFixture();
    broken.setDiagnostic("08S01");
    strict.throws(() => broken.native.check(-1, "fetch", 3, 1n));
    strict.equal(broken.native.reusable, false);
  });
});
