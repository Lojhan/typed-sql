import { Buffer } from "node:buffer";
import { describe, it, strict } from "poku";
import { type OdbcFunctions, OdbcNative, type SqlServerKoffi } from "../src/odbc-native.js";
import {
  ODBC_PHASE,
  type OdbcWorkerOptions,
  odbcPositiveInteger,
  odbcState,
  odbcValueBytes,
  ODBC_STATE as S,
} from "../src/odbc-protocol.js";
import { acknowledgeOdbcCancellation } from "../src/odbc-worker.js";

class Memory {
  value: unknown;
  freed = false;
}
const sdk: SqlServerKoffi = {
  version: "3.3.7",
  load() {
    throw new Error("Native libraries are not used in protocol unit tests");
  },
  sizeof: () => 8,
  out: (type) => type,
  pointer: (type) => type,
  array: (type, length) => ({ type, length }),
  alloc: () => new Memory(),
  free: (pointer) => {
    if (!(pointer instanceof Memory)) throw new TypeError("Invalid test pointer");
    pointer.freed = true;
  },
  encode: (pointer, _type, value) => {
    if (!(pointer instanceof Memory)) throw new TypeError("Invalid test pointer");
    pointer.value = value;
  },
};
function options(overrides: Partial<OdbcWorkerOptions> = {}): OdbcWorkerOptions {
  return {
    modulePath: "unused",
    libraryPath: "unused",
    connectionString: "unused",
    shared: new SharedArrayBuffer(48),
    loginTimeoutSeconds: 15,
    queryTimeoutSeconds: 30,
    maximumCellBytes: 1024 * 1024,
    maximumResultBytes: 1024 * 1024,
    maximumRows: 100,
    chunkBytes: 6,
    ...overrides,
  };
}
const buffer = (value: unknown): Buffer => {
  if (!Buffer.isBuffer(value)) throw new TypeError("Expected native output Buffer");
  return value;
};
const output = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new TypeError("Expected native output pointer");
  return value;
};
await describe("SQL Server direct ODBC native ABI value and cancellation contracts", async () => {
  await it("retrieves REAL and FLOAT using binary C types without decimal formatting", () => {
    for (const [kind, value, size, cType] of [
      ["real", Math.fround(1.23456789), 4, 7],
      ["float", 1.2345678901234567, 8, 8],
    ] as const) {
      const native = new OdbcNative(sdk, options(), {
        SQLGetData: (_stmt, _col, target, data, length, indicator) => {
          strict.equal(target, cType);
          strict.equal(length, size);
          if (size === 4) buffer(data).writeFloatLE(value);
          else buffer(data).writeDoubleLE(value);
          output(indicator)[0] = size;
          return 0;
        },
      });
      native.epoch = 1;
      strict.equal(native.cell(0x1234567890n, 1, false, kind), value);
    }
    for (const indicator of [-1, 2]) {
      const native = new OdbcNative(sdk, options(), {
        SQLGetData: (_s, _c, _t, _d, _l, out) => {
          output(out)[0] = indicator;
          return 0;
        },
      });
      if (indicator === -1) strict.equal(native.cell(1n, 1, false, "float"), null);
      else strict.throws(() => native.cell(1n, 1, false, "float"), /width/);
    }
    const infinite = new OdbcNative(sdk, options(), {
      SQLGetData: (_s, _c, _t, data, _l, out) => {
        buffer(data).writeDoubleLE(Infinity);
        output(out)[0] = 8;
        return 0;
      },
    });
    strict.throws(() => infinite.cell(1n, 1, false, "float"), /nonfinite/);
  });
  await it("copies counted UTF16 chunks before decoding, preserving true NULs and split surrogate pairs", () => {
    for (const binary of [false, true]) {
      const expected = binary ? Buffer.from([0, 1, 0, 2, 0, 3, 0, 4, 0]) : Buffer.from("é\0😀\0", "utf16le");
      let offset = 0;
      const functions: OdbcFunctions = {
        SQLGetData: (_s, _c, target, data, length, indicator) => {
          strict.equal(target, binary ? -2 : -8);
          const capacity = Number(length) - (binary ? 0 : 2),
            remaining = expected.length - offset,
            count = Math.min(capacity, remaining);
          expected.copy(buffer(data), 0, offset, offset + count);
          offset += count;
          output(indicator)[0] = remaining > capacity ? -4 : count;
          return remaining > capacity ? 1 : 0;
        },
        SQLGetDiagRecW: (_k, _h, index, state, native) => {
          if (index !== 1) return 100;
          Buffer.from("01004\0", "utf16le").copy(buffer(state));
          output(native)[0] = 0;
          return 0;
        },
      };
      const value = new OdbcNative(sdk, options(), functions).cell(1n, 1, binary);
      strict.deepEqual(value, binary ? Uint8Array.from(expected) : expected.toString("utf16le"));
    }
  });
  await it("binds MAX Unicode with fixed metadata and distinct null, empty and binary values", () => {
    const calls: unknown[][] = [],
      allocations: unknown[] = [];
    const native = new OdbcNative(sdk, options(), {
      SQLBindParameter: (...args) => {
        calls.push(args);
        return 0;
      },
    });
    native.bind(1n, [null, "", "x\0", new Uint8Array()], allocations);
    strict.equal(allocations.length, 8);
    strict.deepEqual(
      calls.slice(0, 3).map((call) => [call[4], call[5]]),
      [
        [-9, 0],
        [-9, 0],
        [-9, 0],
      ],
    );
    strict.deepEqual(
      calls.map((call) => (call[9] as Memory).value),
      [-1, 0, 4, 0],
    );
    strict.equal(calls[3]?.[3], -2);
    strict.equal(calls[3]?.[4], -4);
    strict.equal(
      allocations.every((pointer) => pointer instanceof Memory && !pointer.freed),
      true,
    );
  });
  await it("acknowledges a cancelled idle epoch even when no native cancellation is needed", () => {
    const config = options(),
      { words } = odbcState(config.shared),
      messages: unknown[] = [];
    Atomics.store(words, S.epoch, 1);
    Atomics.store(words, S.phase, ODBC_PHASE.idle);
    acknowledgeOdbcCancellation(config, 1, (message) => messages.push(message), {});
    strict.deepEqual(messages, [{ ack: 1 }]);
    strict.equal(Atomics.load(words, S.ack), 1);
  });
  await it("rejects cancellation arriving between the initial check and native publication", () => {
    let calls = 0;
    const native = new OdbcNative(sdk, options(), {
      SQLExecute: () => {
        calls++;
        return 0;
      },
    });
    native.epoch = 1;
    const original = native.assertActive.bind(native);
    let checks = 0;
    native.assertActive = () => {
      original();
      if (++checks === 1) {
        Atomics.store(native.state.words, S.cancel, 1);
        Atomics.store(native.state.words, S.ack, 1);
      }
    };
    strict.throws(() => native.call("SQLExecute", 1n, 1n), /cancelled/);
    strict.equal(calls, 0);
    strict.equal(Atomics.load(native.state.words, S.phase), ODBC_PHASE.idle);
  });
  await it("borrows and rechecks only the matching epoch, with acknowledgements on control failure", () => {
    const config = options(),
      { words, handle } = odbcState(config.shared),
      messages: unknown[] = [];
    let calls = 0;
    Atomics.store(words, S.epoch, 3);
    Atomics.store(words, S.kind, 3);
    Atomics.store(handle, 0, 0x1234567890n);
    Atomics.store(words, S.phase, ODBC_PHASE.native);
    acknowledgeOdbcCancellation(config, 3, (message) => messages.push(message), {
      SQLCancelHandle: (kind, value) => {
        strict.equal(kind, 3);
        strict.equal(value, 0x1234567890n);
        strict.equal(Atomics.load(words, S.borrows), 1);
        calls++;
        Atomics.store(words, S.phase, ODBC_PHASE.drain);
        return 0;
      },
    });
    strict.equal(calls, 1);
    strict.equal(Atomics.load(words, S.borrows), 0);
    strict.deepEqual(messages, [{ ack: 3 }]);
    Atomics.store(words, S.phase, ODBC_PHASE.native);
    acknowledgeOdbcCancellation(config, 2, (message) => messages.push(message), {
      SQLCancelHandle: () => {
        throw new Error("stale cancellation dispatched");
      },
    });
    strict.equal(Atomics.load(words, S.controlFailure), 0);
    acknowledgeOdbcCancellation(config, 3, (message) => messages.push(message), {
      SQLCancelHandle: () => {
        throw new Error("control failure");
      },
    });
    strict.deepEqual(messages.at(-1), { ack: 3, failed: true });
    strict.equal(Atomics.load(words, S.controlFailure), 1);
  });
  await it("bounds every payload kind and rejects invalid configured native limits", () => {
    strict.deepEqual([null, "é😀", Uint8Array.of(0, 255), 1.25].map(odbcValueBytes), [0, 6, 2, 8]);
    strict.equal(odbcPositiveInteger(1, "limit"), 1);
    for (const value of [0, -1, Infinity, NaN, 1.5])
      strict.throws(() => odbcPositiveInteger(value, "limit"), /positive safe integer/);
  });
  await it("refuses ambiguous final lengths, unexpected conversion warnings and NULL after partial data", () => {
    for (const indicator of [-4, -2, 1, 8]) {
      const native = new OdbcNative(sdk, options(), {
        SQLGetData: (_s, _c, _t, _b, _l, out) => {
          output(out)[0] = indicator;
          return 0;
        },
      });
      strict.throws(() => native.cell(1n, 1, false), /exact-value-length/);
    }
    let calls = 0;
    const native = new OdbcNative(sdk, options(), {
      SQLGetData: (_s, _c, _t, _b, _l, out) => {
        output(out)[0] = ++calls === 1 ? -4 : -1;
        return calls === 1 ? 1 : 0;
      },
      SQLGetDiagRecW: (_k, _h, index, state, code) => {
        if (index !== 1) return 100;
        Buffer.from("01004\0", "utf16le").copy(buffer(state));
        output(code)[0] = 0;
        return 0;
      },
    });
    strict.throws(() => native.cell(1n, 1, false), /NULL-after-partial/);
    const warning = new OdbcNative(sdk, options(), {
      SQLGetData: (_s, _c, _t, _b, _l, out) => {
        output(out)[0] = -4;
        return 1;
      },
      SQLGetDiagRecW: (_k, _h, index, state, code) => {
        if (index !== 1) return 100;
        Buffer.from("01S07\0", "utf16le").copy(buffer(state));
        output(code)[0] = 0;
        return 0;
      },
    });
    strict.throws(() => warning.cell(1n, 1, false), /conversion-warning/);
  });
});
