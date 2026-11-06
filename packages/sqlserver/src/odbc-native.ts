import { Buffer } from "node:buffer";
import { endianness } from "node:os";
import {
  ODBC_PHASE,
  type OdbcBoundValue,
  type OdbcColumn,
  type OdbcDiagnostic,
  type OdbcValue,
  type OdbcWorkerOptions,
  odbcState,
  ODBC_STATE as S,
} from "./odbc-protocol.js";

// Microsoft severity 10 binding/unbinding notices and the 5060 rollback progress notice; SQLSTATE remains qualified.
// https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/database-engine-events-and-errors-15000-to-15999
// https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/database-engine-events-and-errors-5000-to-5999
export const ODBC_STATEMENT_NOTICES = Object.freeze([
  5060, 5701, 5703, 8153, 15511, 15512, 15513, 15514, 15515, 15516, 15519, 15520, 15521, 15522, 15523, 15524,
]);

interface NativeLibrary {
  func(name: string, result: string, arguments_: readonly unknown[]): unknown;
}
export interface SqlServerKoffi {
  readonly version: string;
  load(path: string): NativeLibrary;
  sizeof(type: string): number;
  out(type: unknown): unknown;
  pointer(type: string): unknown;
  array(type: string, length: number): unknown;
  alloc(type: string, length: number): unknown;
  free(pointer: unknown): void;
  encode(pointer: unknown, type: unknown, value: unknown): void;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
export function requireSqlServerKoffi(value: unknown): SqlServerKoffi {
  const candidate = record(value) && record(value.default) ? value.default : value;
  if (
    !record(candidate) ||
    candidate.version !== "3.3.7" ||
    ["load", "sizeof", "out", "pointer", "array", "alloc", "free", "encode"].some(
      (key) => typeof candidate[key] !== "function",
    )
  )
    throw new TypeError("Exact SQL Server ODBC requires the application-owned Koffi3.3.7 public SDK");
  return candidate as unknown as SqlServerKoffi;
}
export interface OdbcFunctions {
  [name: string]: (...args: unknown[]) => number;
}
export function loadOdbcFunctions(koffi: SqlServerKoffi, libraryPath: string): OdbcFunctions {
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    endianness() !== "LE" ||
    koffi.sizeof("intptr") !== 8 ||
    koffi.sizeof("uint16_t") !== 2
  )
    throw new TypeError(
      "Qualified SQL Server direct ODBC requires little-endian Linux x64 with64-bit SQLLEN and16-bit SQLWCHAR",
    );
  const library = koffi.load(libraryPath),
    h = "uintptr",
    p = "void *",
    out = (type: string) => koffi.out(koffi.pointer(type));
  const definitions: Readonly<Record<string, readonly unknown[]>> = {
    SQLAllocHandle: ["int16_t", h, out(h)],
    SQLSetEnvAttr: [h, "int32_t", h, "int32_t"],
    SQLSetConnectAttrW: [h, "int32_t", h, "int32_t"],
    SQLSetStmtAttrW: [h, "int32_t", h, "int32_t"],
    SQLDriverConnectW: [h, h, p, "int16_t", p, "int16_t", out("int16_t"), "uint16_t"],
    SQLDisconnect: [h],
    SQLGetInfoW: [h, "uint16_t", p, "int16_t", out("int16_t")],
    SQLFreeHandle: ["int16_t", h],
    SQLGetDiagRecW: ["int16_t", h, "int16_t", p, out("int32_t"), p, "int16_t", out("int16_t")],
    SQLExecDirectW: [h, p, "int32_t"],
    SQLPrepareW: [h, p, "int32_t"],
    SQLExecute: [h],
    SQLFreeStmt: [h, "uint16_t"],
    SQLBindParameter: [h, "uint16_t", "int16_t", "int16_t", "int16_t", h, "int16_t", p, "intptr", p],
    SQLNumResultCols: [h, out("int16_t")],
    SQLDescribeColW: [
      h,
      "uint16_t",
      p,
      "int16_t",
      out("int16_t"),
      out("int16_t"),
      out(h),
      out("int16_t"),
      out("int16_t"),
    ],
    SQLColAttributeW: [h, "uint16_t", "uint16_t", p, "int16_t", out("int16_t"), out("intptr")],
    SQLFetch: [h],
    SQLGetData: [h, "uint16_t", "int16_t", p, "intptr", out("intptr")],
    SQLMoreResults: [h],
    SQLCancelHandle: ["int16_t", h],
  };
  return Object.fromEntries(
    Object.entries(definitions).map(([name, args]) => {
      const fn = library.func(name, "int16_t", args);
      if (typeof fn !== "function") throw new TypeError("Invalid native ODBC function export");
      return [
        name,
        (...values: unknown[]) => {
          const result: unknown = fn(...values);
          if (typeof result !== "number") throw new TypeError("Invalid ODBC return code");
          return result;
        },
      ];
    }),
  );
}
export class OdbcNativeError extends Error {
  constructor(
    readonly stage: string,
    readonly diagnostics: readonly OdbcDiagnostic[] = [],
    readonly reusable = true,
  ) {
    super(`SQL Server ODBC ${stage} failed`);
  }
}
export class OdbcNative {
  readonly api: OdbcFunctions;
  readonly state;
  epoch = 0;
  reusable = true;
  constructor(
    readonly koffi: SqlServerKoffi,
    readonly options: OdbcWorkerOptions,
    functions?: OdbcFunctions,
  ) {
    this.api = functions ?? loadOdbcFunctions(koffi, options.libraryPath);
    this.state = odbcState(options.shared);
  }
  diagnostics(kind: number, handle: bigint): readonly OdbcDiagnostic[] {
    const records: OdbcDiagnostic[] = [];
    for (let index = 1; index <= 32; index++) {
      const state = Buffer.alloc(12),
        message = Buffer.alloc(4096),
        native = [0],
        length = [0];
      const rc = this.api.SQLGetDiagRecW!(kind, handle, index, state, native, message, 2048, length);
      if (rc === 100) return records;
      if (rc !== 0 && rc !== 1) return [...records, { state: "DIAGNOSTIC_UNAVAILABLE", native: 0 }];
      records.push({ state: state.subarray(0, 10).toString("utf16le"), native: native[0]! });
    }
    return [...records, { state: "DIAGNOSTIC_LIMIT", native: 0 }];
  }
  check(rc: number, stage: string, kind: number, handle: bigint, allowed: readonly number[] = []): void {
    if (rc === 0) return;
    const diagnostics = this.diagnostics(kind, handle);
    if (
      rc === 1 &&
      diagnostics.length &&
      diagnostics.every(
        (record) =>
          (record.state === "01000" || (record.state === "01003" && record.native === 8153)) &&
          allowed.includes(record.native),
      )
    )
      return;
    if (diagnostics.some((record) => record.state.startsWith("08"))) this.reusable = false;
    throw new OdbcNativeError(stage, diagnostics, this.reusable);
  }
  allocate(kind: number, parent: bigint): bigint {
    const out: (number | bigint)[] = [0n];
    this.check(this.api.SQLAllocHandle!(kind, parent, out), "allocate-handle", Math.max(1, kind - 1), parent);
    const handle = BigInt(out[0]!);
    if (!handle) throw new OdbcNativeError("empty-handle");
    return handle;
  }
  cancelled(): boolean {
    return this.epoch !== 0 && Atomics.load(this.state.words, S.cancel) === this.epoch;
  }
  assertActive(): void {
    if (this.cancelled()) throw new OdbcNativeError("cancelled", [], this.reusable);
    if (Atomics.load(this.state.words, S.controlFailure)) {
      this.reusable = false;
      throw new OdbcNativeError("control-worker", [], false);
    }
  }
  call(name: string, handle: bigint, ...args: unknown[]): number {
    this.assertActive();
    const { words, handle: sharedHandle } = this.state;
    Atomics.store(sharedHandle, 0, handle);
    Atomics.store(words, S.kind, 3);
    Atomics.store(words, S.epoch, this.epoch);
    Atomics.store(words, S.phase, ODBC_PHASE.native);
    try {
      this.assertActive();
      return this.api[name]!(...args);
    } finally {
      Atomics.store(words, S.phase, ODBC_PHASE.drain);
      Atomics.notify(words, S.phase);
      while (Atomics.load(words, S.borrows) !== 0 && !Atomics.load(words, S.controlFailure))
        Atomics.wait(words, S.borrows, Atomics.load(words, S.borrows), 100);
      while (this.cancelled() && Atomics.load(words, S.ack) !== this.epoch && !Atomics.load(words, S.controlFailure))
        Atomics.wait(words, S.ack, Atomics.load(words, S.ack), 100);
      Atomics.store(words, S.phase, ODBC_PHASE.idle);
      if (Atomics.load(words, S.cancelFailure) || Atomics.load(words, S.controlFailure)) this.reusable = false;
    }
  }
  invoke(name: string, handle: bigint, stage: string, ...args: unknown[]): number {
    const rc = this.call(name, handle, ...args);
    this.assertActive();
    this.check(rc, stage, 3, handle, ODBC_STATEMENT_NOTICES);
    return rc;
  }
  wide(text: string): Buffer {
    if (text.length > 1_000_000) throw new OdbcNativeError("SQL-length");
    return Buffer.from(`${text}\0`, "utf16le");
  }
  bind(statement: bigint, values: readonly OdbcBoundValue[], allocations: unknown[]): void {
    for (const [index, value] of values.entries()) {
      this.assertActive();
      const binary = value instanceof Uint8Array;
      const bytes = value === null ? Buffer.alloc(2) : binary ? Buffer.from(value) : this.wide(value);
      const pointer = this.koffi.alloc("uint8_t", Math.max(1, bytes.length));
      allocations.push(pointer);
      this.koffi.encode(pointer, this.koffi.array("uint8_t", Math.max(1, bytes.length)), bytes.length ? bytes : [0]);
      const indicator = this.koffi.alloc("intptr", 1);
      allocations.push(indicator);
      this.koffi.encode(indicator, "intptr", value === null ? -1 : binary ? value.byteLength : value.length * 2);
      this.invoke(
        "SQLBindParameter",
        statement,
        "bind",
        statement,
        index + 1,
        1,
        binary ? -2 : -8,
        binary ? -4 : -9,
        binary ? Math.max(1, value.byteLength) : 0,
        0,
        pointer,
        bytes.length,
        indicator,
      );
    }
  }
  columns(statement: bigint): readonly OdbcColumn[] {
    const count = [0];
    this.invoke("SQLNumResultCols", statement, "result-column-count", statement, count);
    if (!Number.isInteger(count[0]) || count[0]! < 0 || count[0]! > 1024)
      throw new OdbcNativeError("result-column-bound");
    const columns: OdbcColumn[] = [],
      names = new Set<string>();
    for (let index = 1; index <= count[0]!; index++) {
      const name = Buffer.alloc(258),
        nameLength = [0],
        type = [0],
        size: [number | bigint] = [0n],
        scale = [0],
        nullable = [0];
      this.invoke(
        "SQLDescribeColW",
        statement,
        "describe",
        statement,
        index,
        name,
        129,
        nameLength,
        type,
        size,
        scale,
        nullable,
      );
      const typeName = Buffer.alloc(258),
        typeLength = [0],
        numeric: [number | bigint] = [0n];
      this.invoke(
        "SQLColAttributeW",
        statement,
        "native-type-name",
        statement,
        index,
        14,
        typeName,
        258,
        typeLength,
        numeric,
      );
      if (
        nameLength[0]! < 1 ||
        nameLength[0]! > 128 ||
        typeLength[0]! < 1 ||
        typeLength[0]! > 256 ||
        typeLength[0]! % 2
      )
        throw new OdbcNativeError("metadata-bound");
      const label = name.subarray(0, nameLength[0]! * 2).toString("utf16le"),
        native = typeName.subarray(0, typeLength[0]).toString("utf16le");
      if (native.toLowerCase() === "sql_variant") throw new OdbcNativeError("unqualified-sql-variant-codec");
      if (names.has(label)) throw new OdbcNativeError("duplicate-column-name");
      names.add(label);
      const width = Number(size[0]);
      if (!Number.isSafeInteger(width) || width < 0) throw new OdbcNativeError("column-size");
      columns.push({
        name: label,
        typeName: native,
        type: type[0]!,
        size: width,
        scale: scale[0]!,
        nullable: nullable[0] !== 0,
      });
    }
    return columns;
  }
  cell(
    statement: bigint,
    index: number,
    binary: boolean,
    floating?: "real" | "float",
    maximumBytes = this.options.maximumCellBytes,
  ): OdbcValue {
    if (floating) {
      const size = floating === "real" ? 4 : 8,
        buffer = Buffer.alloc(size),
        indicator: [number | bigint] = [0n];
      const rc = this.call(
        "SQLGetData",
        statement,
        statement,
        index,
        floating === "real" ? 7 : 8,
        buffer,
        size,
        indicator,
      );
      this.assertActive();
      this.check(rc, "floating-result", 3, statement);
      if (Number(indicator[0]) === -1) return null;
      if (size > maximumBytes) throw new OdbcNativeError("result-memory-bound");
      if (Number(indicator[0]) !== size) throw new OdbcNativeError("floating-result-width");
      const value = floating === "real" ? buffer.readFloatLE() : buffer.readDoubleLE();
      if (!Number.isFinite(value)) throw new OdbcNativeError("nonfinite-floating-result");
      return value;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const payload = this.options.chunkBytes,
      capacity = payload + (binary ? 0 : 2);
    for (let call = 0; call < 65536; call++) {
      const buffer = Buffer.alloc(capacity),
        indicator: [number | bigint] = [0n];
      const rc = this.call("SQLGetData", statement, statement, index, binary ? -2 : -8, buffer, capacity, indicator);
      this.assertActive();
      const length = Number(indicator[0]);
      if (rc !== 0 && rc !== 1) this.check(rc, "get-data", 3, statement);
      if (length === -1) {
        if (call || rc !== 0) throw new OdbcNativeError("NULL-after-partial-value");
        return null;
      }
      let bytes = length;
      if (rc === 1) {
        const records = this.diagnostics(3, statement);
        if (
          !records.length ||
          records.some((record) => record.state !== "01004") ||
          !(length === -4 || length > payload)
        )
          throw new OdbcNativeError("conversion-warning", records);
        bytes = payload;
      }
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > payload || (!binary && bytes % 2))
        throw new OdbcNativeError("exact-value-length");
      total += bytes;
      if (total > Math.min(this.options.maximumCellBytes, maximumBytes)) throw new OdbcNativeError("cell-byte-limit");
      chunks.push(Buffer.from(buffer.subarray(0, bytes)));
      if (rc === 0) {
        const value = Buffer.concat(chunks);
        return binary ? Uint8Array.from(value) : value.toString("utf16le");
      }
    }
    throw new OdbcNativeError("cell-chunk-limit");
  }
}
