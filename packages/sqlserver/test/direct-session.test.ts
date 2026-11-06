import { Buffer } from "node:buffer";
import { describe, it, strict } from "poku";
import { idColumn, nativeApiFixture } from "./helpers/direct-api.js";

await describe("SQL Server data worker statement and retained-memory protocol", async () => {
  await it("attests actual counted driver identity before dispatch and cleans up rejected drivers", () => {
    const qualified = nativeApiFixture();
    qualified.session.open();
    strict.deepEqual(qualified.session.driverIdentity, {
      name: "libmsodbcsql-18.7.so.1.1",
      version: "18.07.0001",
      odbcVersion: "03.52",
      managerVersion: "03.52.0002.0003",
    });
    strict.equal(Object.isFrozen(qualified.session.driverIdentity), true);
    qualified.session.close();
    for (const [code, value] of [
      [6, "libtdsodbc.so"],
      [7, "19.00.0001"],
      [77, "02.00"],
      [171, "unixODBC2.3.12"],
      [6, "bad\0driver"],
    ] as const) {
      const state = nativeApiFixture();
      const original = state.native.api.SQLGetInfoW!;
      state.native.api.SQLGetInfoW = (...args) => {
        if (args[1] !== code) return original(...args);
        if (!Buffer.isBuffer(args[2]) || !Array.isArray(args[4])) throw new Error("Invalid native test output");
        Buffer.from(value, "utf16le").copy(args[2]);
        args[4][0] = value.length * 2;
        return 0;
      };
      strict.throws(() => state.session.open());
      strict.equal(
        state.calls.some((call) => call.name === "SQLExecDirectW"),
        false,
      );
      strict.equal(state.session.connection, 0n);
      strict.equal(state.session.env, 0n);
    }
    const unreadable = nativeApiFixture();
    unreadable.failed.set("SQLGetInfoW", 1);
    strict.throws(() => unreadable.session.open(), /driver-identity/);
    strict.equal(unreadable.session.connection, 0n);
    for (const length of [-1, 0, 1, 1024, 1026, 1.5]) {
      const state = nativeApiFixture();
      state.native.api.SQLGetInfoW = (...args) => {
        if (!Array.isArray(args[4])) throw new Error("Invalid native test length");
        args[4][0] = length;
        return 0;
      };
      strict.throws(() => state.session.open(), /driver-identity-length/);
      strict.equal(state.session.connection, 0n);
    }
  });

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
  await it("accepts only proven successful legacy binding notices without tolerating truncation or errors", () => {
    // Vendor severity10 messages15511..15516 describe successful default/rule binding only.
    for (const message of [5060, 15511, 15512, 15513, 15514, 15515, 15516]) {
      const state = nativeApiFixture();
      state.session.open();
      state.setDiagnostic("01000", message);
      const execute = state.native.api.SQLExecDirectW!;
      state.native.api.SQLExecDirectW = (...args) => {
        execute(...args);
        return 1;
      };
      strict.deepEqual(
        state.session.command({ id: 1, kind: "execute", text: "EXEC trusted binding setup", values: [] }).result?.rows,
        [["1"]],
      );
      state.session.close();
    }
    for (const [stateCode, message, rc] of [
      ["01004", 15512, 1],
      ["01004", 5060, 1],
      ["01000", 5060, -1],
      ["01000", 15517, 1],
      ["01000", 50000, 1],
      ["01000", 15512, -1],
    ] as const) {
      const state = nativeApiFixture();
      state.session.open();
      state.setDiagnostic(stateCode, message);
      state.native.api.SQLExecDirectW = () => rc;
      strict.throws(
        () => state.session.command({ id: 1, kind: "execute", text: "EXEC rejected warning", values: [] }),
        /execute/,
      );
      state.session.close();
    }
    const mixed = nativeApiFixture();
    mixed.session.open();
    mixed.native.api.SQLExecDirectW = () => 1;
    mixed.native.diagnostics = () => [
      { state: "01000", native: 15512 },
      { state: "01004", native: 0 },
    ];
    strict.throws(
      () => mixed.session.command({ id: 1, kind: "execute", text: "EXEC mixed warning", values: [] }),
      /execute/,
    );
    mixed.session.close();
  });

  await it("preserves the original native failure while quarantining failed cleanup", () => {
    for (const [failedCall, stage, kind] of [
      ["SQLSetStmtAttrW", "query-timeout", "execute"],
      ["SQLPrepareW", "prepare", "prepare"],
      ["SQLExecDirectW", "execute", "execute"],
      ["SQLFetch", "fetch", "execute"],
    ] as const) {
      const state = nativeApiFixture();
      state.session.open();
      state.failed.set(failedCall, 1);
      state.failed.set("SQLFreeHandle", 1);
      strict.throws(
        () => {
          if (kind === "prepare") state.session.command({ id: 1, kind, text: "SELECT source" });
          else state.session.command({ id: 1, kind, text: "SELECT source", values: [] });
        },
        new RegExp(`ODBC ${stage}`),
      );
      strict.equal(state.native.reusable, false);
      strict.equal(state.session.owned.size, 1);
      strict.throws(
        () => state.session.command({ id: 2, kind: "execute", text: "SELECT unsafe", values: [] }),
        /quarantined/,
      );
      state.session.close();
      strict.equal(state.session.owned.size, 0);
      strict.equal(state.session.connection, 0n);
    }
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
