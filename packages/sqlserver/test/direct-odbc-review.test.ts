import { Buffer } from "node:buffer";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, it, strict } from "poku";
import { type OdbcFunctions, OdbcNative, type SqlServerKoffi } from "../src/odbc-native.js";
import {
  ODBC_PHASE,
  type OdbcColumn,
  type OdbcWorkerOptions,
  odbcState,
  ODBC_STATE as S,
} from "../src/odbc-protocol.js";
import { OdbcSession } from "../src/odbc-session.js";
import { acknowledgeOdbcCancellation } from "../src/odbc-worker.js";

// These tests exercise the actual worker/session algorithms, substituting only
// the C API boundary. Native ABI/fidelity evidence belongs to the four-engine CI.
class Allocation {
  value: unknown;
  freed = false;
}
function memory() {
  const allocations: Allocation[] = [];
  const sdk: SqlServerKoffi = {
    version: "3.3.7",
    load() {
      throw new Error("Protocol tests must not load a native driver");
    },
    sizeof: () => 8,
    out: (type) => type,
    pointer: (type) => type,
    array: (type, length) => ({ type, length }),
    alloc() {
      const value = new Allocation();
      allocations.push(value);
      return value;
    },
    free(pointer) {
      if (!(pointer instanceof Allocation) || pointer.freed) throw new Error("Invalid or repeated native free");
      pointer.freed = true;
    },
    encode(pointer, _type, value) {
      if (!(pointer instanceof Allocation) || pointer.freed) throw new Error("Invalid native write");
      pointer.value = value;
    },
  };
  return { sdk, allocations };
}
function options(overrides: Partial<OdbcWorkerOptions> = {}): OdbcWorkerOptions {
  return {
    modulePath: "unused",
    libraryPath: "unused",
    connectionString: "unused",
    shared: new SharedArrayBuffer(48),
    loginTimeoutSeconds: 15,
    queryTimeoutSeconds: 5,
    maximumCellBytes: 50,
    maximumResultBytes: 10,
    maximumRows: 100,
    chunkBytes: 6,
    ...overrides,
  };
}
function output(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected native output reference");
  return value;
}
function buffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value)) throw new Error("Expected native byte buffer");
  return value;
}
function diagnostic(state: string): OdbcFunctions["SQLGetDiagRecW"] {
  return (_kind, _handle, record, target, native) => {
    if (record !== 1) return 100;
    Buffer.from(`${state}\0`, "utf16le").copy(buffer(target));
    output(native)[0] = 0;
    return 0;
  };
}
function session(overrides: OdbcFunctions = {}, config = options()) {
  const heap = memory();
  let handle = 100n;
  const freed: bigint[] = [];
  const native = new OdbcNative(heap.sdk, config, {
    SQLAllocHandle: (_kind, _parent, result) => {
      output(result)[0] = ++handle;
      return 0;
    },
    SQLSetStmtAttrW: () => 0,
    SQLFreeHandle: (_kind, value) => {
      freed.push(BigInt(String(value)));
      return 0;
    },
    SQLBindParameter: () => 0,
    SQLDisconnect: () => 0,
    ...overrides,
  });
  const connection = new OdbcSession(native);
  connection.env = 98n;
  connection.connection = 99n;
  connection.connected = true;
  return { ...heap, native, connection, freed };
}

await describe("independent direct ODBC resource and cancellation review", async () => {
  await it("waits for a real cross-isolate cancellation borrow before leaving native DRAIN", async () => {
    const config = options(),
      state = odbcState(config.shared);
    const signals = new SharedArrayBuffer(16),
      flags = new Int32Array(signals);
    const worker = new Worker(
      `
      const { workerData } = require('node:worker_threads');
      const { shared, signals, S, P } = workerData;
      const state = new Int32Array(shared), flags = new Int32Array(signals);
      const until = Date.now() + 3000;
      while (Atomics.load(state,S.phase) !== P.native && Date.now() < until)
        Atomics.wait(state,S.phase,Atomics.load(state,S.phase),20);
      if (Atomics.load(state,S.phase) !== P.native) throw new Error('native phase never arrived');
      Atomics.add(state,S.borrows,1);
      Atomics.store(flags,0,1); Atomics.notify(flags,0);
      while (Atomics.load(state,S.phase) !== P.drain && Date.now() < until)
        Atomics.wait(state,S.phase,Atomics.load(state,S.phase),20);
      if (Atomics.load(state,S.phase) !== P.drain) throw new Error('DRAIN never arrived');
      if (Atomics.load(flags,2)) throw new Error('native call returned while borrowed');
      Atomics.store(flags,1,1);
      Atomics.sub(state,S.borrows,1); Atomics.notify(state,S.borrows);
    `,
      { eval: true, workerData: { shared: config.shared, signals, S, P: ODBC_PHASE } },
    );
    const exited = once(worker, "exit");
    const native = new OdbcNative(memory().sdk, config, {
      SQLExecute() {
        const deadline = Date.now() + 3000;
        while (!Atomics.load(flags, 0) && Date.now() < deadline) Atomics.wait(flags, 0, 0, 20);
        strict.equal(Atomics.load(flags, 0), 1, "Control isolate acquired native borrow");
        strict.equal(Atomics.load(state.words, S.borrows), 1);
        return 0;
      },
    });
    native.epoch = 1;
    try {
      strict.equal(native.call("SQLExecute", 0x1234567890n, 0x1234567890n), 0);
      Atomics.store(flags, 2, 1);
      strict.equal(Atomics.load(flags, 1), 1, "DRAIN settled the borrow before returning");
      strict.equal(Atomics.load(state.words, S.borrows), 0);
      strict.equal(Atomics.load(state.words, S.phase), ODBC_PHASE.idle);
      strict.deepEqual(await exited, [0]);
    } finally {
      await worker.terminate();
    }
  });

  await it("rechecks epoch and phase after borrowing instead of cancelling a reused statement", () => {
    for (const interleaving of ["new-epoch", "drain"] as const) {
      const config = options(),
        { words, handle } = odbcState(config.shared);
      Atomics.store(words, S.epoch, 7);
      Atomics.store(words, S.phase, ODBC_PHASE.native);
      Atomics.store(words, S.kind, 3);
      Atomics.store(handle, 0, 0x1234567890n);
      const property = Object.getOwnPropertyDescriptor(Atomics, "add")!;
      const original = Atomics.add;
      let dispatched = 0,
        injected = false;
      Object.defineProperty(Atomics, "add", {
        ...property,
        value(array: Int32Array, index: number, value: number) {
          const result = original(array, index, value);
          if (array.buffer === words.buffer && index === S.borrows && !injected) {
            injected = true;
            if (interleaving === "new-epoch") Atomics.store(words, S.epoch, 8);
            else Atomics.store(words, S.phase, ODBC_PHASE.drain);
          }
          return result;
        },
      });
      const messages: unknown[] = [];
      try {
        acknowledgeOdbcCancellation(config, 7, (message) => messages.push(message), {
          SQLCancelHandle() {
            dispatched++;
            return 0;
          },
        });
      } finally {
        Object.defineProperty(Atomics, "add", property);
      }
      strict.equal(injected, true);
      strict.equal(dispatched, 0);
      strict.equal(Atomics.load(words, S.borrows), 0);
      strict.deepEqual(messages, [{ ack: 7 }]);
    }
  });

  await it("applies the native query timeout to every allocated statement", () => {
    const seen: unknown[][] = [];
    const fixture = session({
      SQLSetStmtAttrW: (...args) => {
        seen.push(args);
        return 0;
      },
    });
    const first = fixture.connection.create(false),
      second = fixture.connection.create(true);
    strict.deepEqual(seen, [
      [first.handle, 0, 5n, 0],
      [second.handle, 0, 5n, 0],
    ]);
    fixture.connection.close();
  });

  await it("stops reading subsequent columns when the remaining row budget is exhausted", () => {
    const read: number[] = [],
      offsets = new Map<number, number>();
    const fixture = session({
      SQLFetch: () => 0,
      SQLGetData: (_statement, column, _type, target, length, indicator) => {
        const ordinal = Number(column);
        read.push(ordinal);
        const bytes = Buffer.from(ordinal === 1 ? "ab" : "cdef", "utf16le");
        const offset = offsets.get(ordinal) ?? 0,
          capacity = Number(length) - 2;
        const count = Math.min(bytes.length - offset, capacity);
        bytes.copy(buffer(target), 0, offset, offset + count);
        offsets.set(ordinal, offset + count);
        output(indicator)[0] = bytes.length - offset > capacity ? -4 : count;
        return bytes.length - offset > capacity ? 1 : 0;
      },
      SQLGetDiagRecW: diagnostic("01004"),
    });
    const statement = fixture.connection.create(false);
    statement.columns = [1, 2, 3].map(
      (index): OdbcColumn => ({
        name: `c${index}`,
        typeName: "nvarchar",
        type: -9,
        size: 4,
        scale: 0,
        nullable: false,
      }),
    );
    try {
      strict.throws(() => fixture.connection.fetch(statement, 10), /cell-byte-limit|result-memory-bound/u);
      strict.deepEqual(read, [1, 2, 2], "No later column is read after a partial value exceeds the remaining budget");
    } finally {
      fixture.connection.close();
    }
  });

  await it("retains deferred parameter pointers when resetting native parameters fails", () => {
    const fixture = session({
      SQLFreeStmt: (_statement, option) => (option === 3 ? -1 : 0),
      SQLGetDiagRecW: diagnostic("HY010"),
    });
    const statement = fixture.connection.create(true);
    fixture.native.bind(statement.handle, ["x\0", new Uint8Array([0, 1])], statement.allocations);
    strict.equal(fixture.allocations.length, 4);
    strict.throws(() => fixture.connection.start("", ["replacement"], statement), /reset-parameters/u);
    strict.ok(fixture.allocations.every((pointer) => !pointer.freed));
    strict.equal(statement.allocations.length, 4);
    fixture.connection.destroy(statement);
    strict.ok(fixture.allocations.every((pointer) => pointer.freed));
    fixture.connection.close();
  });

  await it("refuses freeing a borrowed handle, then permits settled quarantined cleanup", () => {
    const fixture = session();
    const statement = fixture.connection.create(true);
    fixture.native.bind(statement.handle, ["retained"], statement.allocations);
    Atomics.store(fixture.native.state.words, S.borrows, 1);
    strict.throws(() => fixture.connection.destroy(statement), /unsettled-native-borrow/u);
    strict.deepEqual(fixture.freed, []);
    strict.ok(fixture.allocations.every((pointer) => !pointer.freed));
    Atomics.store(fixture.native.state.words, S.borrows, 0);
    strict.equal(fixture.native.reusable, false);
    fixture.connection.command({ kind: "close", id: 1 });
    strict.deepEqual(fixture.freed, [statement.handle, 99n, 98n]);
    strict.ok(fixture.allocations.every((pointer) => pointer.freed));
  });

  await it("attempts other statement frees after a failure while retaining the failed handle's memory", () => {
    const attempts: bigint[] = [];
    const fixture = session({
      SQLFreeHandle: (_kind, handle) => {
        const value = BigInt(String(handle));
        attempts.push(value);
        return value === 101n ? -1 : 0;
      },
      SQLGetDiagRecW: diagnostic("HY000"),
    });
    const first = fixture.connection.create(true),
      second = fixture.connection.create(true);
    fixture.native.bind(first.handle, ["first"], first.allocations);
    fixture.native.bind(second.handle, ["second"], second.allocations);
    strict.throws(() => fixture.connection.close(), /free-statement/u);
    strict.deepEqual(attempts, [first.handle, second.handle]);
    strict.ok(fixture.allocations.slice(0, 2).every((pointer) => !pointer.freed));
    strict.ok(fixture.allocations.slice(2).every((pointer) => pointer.freed));
    strict.equal(fixture.native.reusable, false);
  });
});
