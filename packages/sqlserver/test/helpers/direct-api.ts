import { Buffer } from "node:buffer";
import { type OdbcFunctions, OdbcNative, type SqlServerKoffi } from "../../src/odbc-native.js";
import type { OdbcColumn, OdbcValue, OdbcWorkerOptions } from "../../src/odbc-protocol.js";
import { OdbcSession } from "../../src/odbc-session.js";
export class Allocation {
  value: unknown;
  freed = false;
}
interface Stage {
  readonly columns: readonly OdbcColumn[];
  readonly rows: readonly (readonly OdbcValue[])[];
}
interface State {
  stages: readonly Stage[];
  stage: number;
  row: number;
  offsets: Map<number, number>;
}
function output(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid test native output");
  return value;
}
function buffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value)) throw new Error("Invalid test native buffer");
  return value;
}
export const idColumn: OdbcColumn = { name: "id", typeName: "bigint", type: -5, size: 19, scale: 0, nullable: false };
export function nativeApiFixture(overrides: Partial<OdbcWorkerOptions> = {}) {
  const allocations: Allocation[] = [],
    calls: { name: string; args: readonly unknown[] }[] = [],
    states = new Map<bigint, State>(),
    plans: (readonly Stage[])[] = [];
  let next = 1n,
    diagnostic = "HY000",
    diagnosticNative = 0;
  const failed = new Map<string, number>();
  const sdk: SqlServerKoffi = {
    version: "3.3.7",
    load() {
      throw new Error("No driver used in protocol tests");
    },
    sizeof: () => 8,
    out: (type) => type,
    pointer: (type) => type,
    array: (type, length) => ({ type, length }),
    alloc() {
      const pointer = new Allocation();
      allocations.push(pointer);
      return pointer;
    },
    free(pointer) {
      if (!(pointer instanceof Allocation) || pointer.freed) throw new Error("Native buffer freed twice");
      pointer.freed = true;
    },
    encode(pointer, _type, value) {
      if (!(pointer instanceof Allocation) || pointer.freed) throw new Error("Invalid retained native memory");
      pointer.value = value;
    },
  };
  const current = (handle: unknown) => {
    const state = states.get(BigInt(String(handle)));
    if (!state) throw new Error("Unknown test statement");
    return state;
  };
  const stage = (handle: unknown) => {
    const state = current(handle);
    return state.stages[state.stage] ?? { columns: [], rows: [] };
  };
  const execute = (handle: unknown) => {
    const state = current(handle);
    state.stages = plans.shift() ?? [{ columns: [idColumn], rows: [["1"]] }];
    state.stage = 0;
    state.row = -1;
    state.offsets.clear();
    return 0;
  };
  const raw: OdbcFunctions = {
    SQLAllocHandle: (kind, _parent, out) => {
      const handle = next++;
      output(out)[0] = handle;
      if (kind === 3)
        states.set(handle, { stages: [{ columns: [idColumn], rows: [] }], stage: 0, row: -1, offsets: new Map() });
      return 0;
    },
    SQLSetEnvAttr: () => 0,
    SQLSetConnectAttrW: () => 0,
    SQLSetStmtAttrW: () => 0,
    SQLDriverConnectW: () => 0,
    SQLDisconnect: () => 0,
    SQLFreeHandle: (kind, handle) => {
      if (kind === 3) states.delete(BigInt(String(handle)));
      return 0;
    },
    SQLPrepareW: () => 0,
    SQLExecute: execute,
    SQLExecDirectW: execute,
    SQLFreeStmt: () => 0,
    SQLBindParameter: () => 0,
    SQLNumResultCols: (handle, out) => {
      output(out)[0] = stage(handle).columns.length;
      return 0;
    },
    SQLDescribeColW: (handle, ordinal, name, _bound, nameLength, type, size, scale, nullable) => {
      const column = stage(handle).columns[Number(ordinal) - 1]!;
      Buffer.from(column.name, "utf16le").copy(buffer(name));
      output(nameLength)[0] = column.name.length;
      output(type)[0] = column.type;
      output(size)[0] = column.size;
      output(scale)[0] = column.scale;
      output(nullable)[0] = column.nullable ? 1 : 0;
      return 0;
    },
    SQLColAttributeW: (handle, ordinal, _attribute, name, _bound, length) => {
      const type = stage(handle).columns[Number(ordinal) - 1]!.typeName;
      Buffer.from(type, "utf16le").copy(buffer(name));
      output(length)[0] = type.length * 2;
      return 0;
    },
    SQLFetch: (handle) => {
      const state = current(handle);
      state.offsets.clear();
      state.row++;
      return state.row < stage(handle).rows.length ? 0 : 100;
    },
    SQLGetData: (handle, ordinal, type, data, length, indicator) => {
      const state = current(handle),
        index = Number(ordinal) - 1,
        value = stage(handle).rows[state.row]![index];
      if (value === null) {
        output(indicator)[0] = -1;
        return 0;
      }
      if (type === 7 || type === 8) {
        if (type === 7) buffer(data).writeFloatLE(Number(value));
        else buffer(data).writeDoubleLE(Number(value));
        output(indicator)[0] = type === 7 ? 4 : 8;
        return 0;
      }
      const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value), "utf16le"),
        capacity = Number(length) - (type === -2 ? 0 : 2),
        offset = state.offsets.get(index) ?? 0,
        remaining = bytes.length - offset,
        count = Math.min(capacity, remaining);
      bytes.copy(buffer(data), 0, offset, offset + count);
      state.offsets.set(index, offset + count);
      output(indicator)[0] = remaining > capacity ? -4 : count;
      if (remaining > capacity) {
        diagnostic = "01004";
        diagnosticNative = 0;
        return 1;
      }
      return 0;
    },
    SQLMoreResults: (handle) => {
      const state = current(handle);
      state.stage++;
      state.row = -1;
      state.offsets.clear();
      return state.stage < state.stages.length ? 0 : 100;
    },
    SQLGetDiagRecW: (_kind, _handle, index, data, native) => {
      if (index !== 1) return 100;
      Buffer.from(`${diagnostic}\0`, "utf16le").copy(buffer(data));
      output(native)[0] = diagnosticNative;
      return 0;
    },
  };
  const functions: OdbcFunctions = Object.fromEntries(
    Object.entries(raw).map(([name, fn]) => [
      name,
      (...args: unknown[]) => {
        calls.push({ name, args });
        if ((failed.get(name) ?? 0) > 0) {
          failed.set(name, failed.get(name)! - 1);
          diagnostic = "HY000";
          diagnosticNative = 0;
          return -1;
        }
        return fn(...args);
      },
    ]),
  );
  const options: OdbcWorkerOptions = {
    modulePath: "unused",
    libraryPath: "unused",
    connectionString: "Driver={test}",
    shared: new SharedArrayBuffer(48),
    loginTimeoutSeconds: 15,
    queryTimeoutSeconds: 30,
    maximumCellBytes: 1024,
    maximumResultBytes: 4096,
    maximumRows: 100,
    chunkBytes: 6,
    ...overrides,
  };
  const native = new OdbcNative(sdk, options, functions),
    session = new OdbcSession(native);
  return {
    native,
    session,
    allocations,
    calls,
    states,
    plans,
    failed,
    functions,
    raw,
    setDiagnostic(state: string, code = 0) {
      diagnostic = state;
      diagnosticNative = code;
    },
  };
}
