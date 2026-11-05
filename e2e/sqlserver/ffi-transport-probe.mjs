// Research-only synchronous ODBC transport. Run in a dedicated qualification process.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";

const require = createRequire(import.meta.url);
const koffi = process.env.TYPED_SQL_KOFFI_MODULE ? require(process.env.TYPED_SQL_KOFFI_MODULE) : require("koffi");
assert.equal(koffi.version, "3.3.7");
assert.equal(os.endianness(), "LE", "Prototype requires little-endian UTF-16 ABI");
assert.equal(koffi.sizeof("intptr"), 8, "Prototype qualifies 64-bit SQLLEN only");
assert.equal(koffi.sizeof("uint16_t"), 2);
const library = process.env.TYPED_SQL_ODBC_LIBRARY ?? "libodbc.so.2";
const lib = koffi.load(library);
const fn = (name, args) => lib.func(name, "int16_t", args);
const p = "void *";
const out = (type) => koffi.out(koffi.pointer(type));
const api = {
  alloc: fn("SQLAllocHandle", ["int16_t", p, out(p)]),
  envAttr: fn("SQLSetEnvAttr", [p, "int32_t", p, "int32_t"]),
  connect: fn("SQLDriverConnectW", [p, p, p, "int16_t", p, "int16_t", out("int16_t"), "uint16_t"]),
  disconnect: fn("SQLDisconnect", [p]),
  free: fn("SQLFreeHandle", ["int16_t", p]),
  diag: fn("SQLGetDiagRecW", ["int16_t", p, "int16_t", p, out("int32_t"), p, "int16_t", out("int16_t")]),
  direct: fn("SQLExecDirectW", [p, p, "int32_t"]),
  prepare: fn("SQLPrepareW", [p, p, "int32_t"]),
  bind: fn("SQLBindParameter", [p, "uint16_t", "int16_t", "int16_t", "int16_t", "uintptr", "int16_t", p, "intptr", p]),
  execute: fn("SQLExecute", [p]),
  columns: fn("SQLNumResultCols", [p, out("int16_t")]),
  describe: fn("SQLDescribeColW", [
    p,
    "uint16_t",
    p,
    "int16_t",
    out("int16_t"),
    out("int16_t"),
    out("uintptr"),
    out("int16_t"),
    out("int16_t"),
  ]),
  fetch: fn("SQLFetch", [p]),
  get: fn("SQLGetData", [p, "uint16_t", "int16_t", p, "intptr", out("intptr")]),
  more: fn("SQLMoreResults", [p]),
};
const evidence = {
  formatVersion: 1,
  transport: "koffi-direct-odbc",
  koffi: koffi.version,
  platform: process.platform,
  arch: process.arch,
  abi: { sqlLenBytes: koffi.sizeof("intptr"), sqlWcharBytes: 2 },
  major: Number(process.env.TYPED_SQL_SQLSERVER_MAJOR),
  cases: [],
};
// Diagnostic messages can contain credentials or SQL data. Read but never emit them.
function diagnostics(kind, handle) {
  const records = [];
  for (let record = 1; record <= 32; record++) {
    const state = Buffer.alloc(12);
    const message = Buffer.alloc(4096);
    const native = [0];
    const length = [0];
    const rc = api.diag(kind, handle, record, state, native, message, 2048, length);
    if (rc === 100) return records;
    if (rc !== 0 && rc !== 1) return [...records, { state: "DIAGNOSTIC_UNAVAILABLE" }];
    records.push({ state: state.subarray(0, 10).toString("utf16le"), native: native[0] });
  }
  return [...records, { state: "DIAGNOSTIC_LIMIT" }];
}
function check(rc, stage, kind, handle) {
  // Warnings fail closed except specifically checked SQLGetData 01004.
  if (rc !== 0) {
    const error = new Error(stage);
    error.evidence = { stage, rc, diagnostics: handle ? diagnostics(kind, handle) : [] };
    throw error;
  }
}
function allocate(kind, parent) {
  const handle = [null];
  check(api.alloc(kind, parent, handle), "allocate-handle", kind === 1 ? 1 : kind - 1, parent);
  assert.ok(handle[0]);
  return handle[0];
}
const wide = (text) => Buffer.from(`${text}\0`, "utf16le");
const digest = (value) => (value === null ? null : createHash("sha256").update(value).digest("hex"));
function stable(bytes, allocations) {
  const pointer = koffi.alloc("uint8_t", Math.max(1, bytes.length));
  allocations.push(pointer);
  koffi.encode(pointer, koffi.array("uint8_t", Math.max(1, bytes.length)), bytes.length ? bytes : [0]);
  return pointer;
}
function bind(statement, values, allocations) {
  values.forEach((value, index) => {
    const binary = value.kind === "binary";
    const bytes =
      value.value === null ? Buffer.alloc(binary ? 1 : 2) : binary ? Buffer.from(value.value) : wide(value.value);
    const data = stable(bytes, allocations);
    const indicator = koffi.alloc("intptr", 1);
    allocations.push(indicator);
    const size = value.value === null ? -1 : binary ? value.value.length : value.value.length * 2;
    koffi.encode(indicator, "intptr", size);
    check(
      api.bind(
        statement,
        index + 1,
        1,
        binary ? -2 : -8,
        binary ? -4 : -10,
        Math.max(1, value.value?.length ?? 0),
        0,
        data,
        bytes.length,
        indicator,
      ),
      "bind",
      3,
      statement,
    );
  });
}
function readCell(statement, ordinal, binary, payloadBytes) {
  const chunks = [];
  const trace = [];
  const capacity = payloadBytes + (binary ? 0 : 2);
  let total = 0;
  for (let call = 0; call < 65536; call++) {
    const buffer = Buffer.alloc(capacity, 0xa5);
    const indicator = [0];
    const rc = api.get(statement, ordinal, binary ? -2 : -8, buffer, capacity, indicator);
    const length = Number(indicator[0]);
    const records = rc === 1 ? diagnostics(3, statement) : [];
    trace.push({ rc, indicator: length, states: records.map((entry) => entry.state) });
    if (rc !== 0 && rc !== 1) check(rc, "get-data", 3, statement);
    if (length === -1) {
      assert.equal(call, 0, "NULL after partial data");
      assert.equal(rc, 0);
      return { value: null, trace };
    }
    let count;
    if (rc === 1) {
      assert.ok(
        records.length > 0 && records.every((entry) => entry.state === "01004"),
        "Unexpected conversion warning",
      );
      assert.ok(length === -4 || length > payloadBytes, "Truncation requires remaining data");
      count = payloadBytes;
    } else {
      assert.ok(
        Number.isSafeInteger(length) && length >= 0 && length <= payloadBytes,
        "Final exact indicator required",
      );
      count = length;
    }
    assert.ok(binary || count % 2 === 0, "Odd UTF-16 byte count");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
    total += count;
    assert.ok(total <= 16 * 1024 * 1024, "Probe cell limit");
    if (rc === 0) {
      const bytes = Buffer.concat(chunks);
      return { value: binary ? bytes : bytes.toString("utf16le"), trace };
    }
  }
  throw new Error("get-data-call-limit");
}
function query(connection, text, values = [], payloadBytes = 4096) {
  assert.ok(text.length < 1_000_000);
  const statement = allocate(3, connection);
  const allocations = [];
  try {
    if (values.length) {
      check(api.prepare(statement, wide(text), text.length), "prepare", 3, statement);
      bind(statement, values, allocations);
      // Stable input/indicator allocations survive execution, GC and all result draining.
      globalThis.gc?.();
      check(api.execute(statement), "execute", 3, statement);
    } else check(api.direct(statement, wide(text), text.length), "exec-direct", 3, statement);
    const count = [0];
    check(api.columns(statement, count), "result-column-count", 3, statement);
    assert.ok(count[0] > 0 && count[0] <= 128);
    const metadata = [];
    for (let ordinal = 1; ordinal <= count[0]; ordinal++) {
      const name = Buffer.alloc(258);
      const nameLength = [0],
        type = [0],
        size = [0],
        scale = [0],
        nullable = [0];
      check(
        api.describe(statement, ordinal, name, 129, nameLength, type, size, scale, nullable),
        "describe",
        3,
        statement,
      );
      assert.ok(nameLength[0] >= 0 && nameLength[0] < 129);
      metadata.push({
        name: name.subarray(0, nameLength[0] * 2).toString("utf16le"),
        type: type[0],
        size: Number(size[0]),
        scale: scale[0],
        nullable: nullable[0],
      });
    }
    const rows = [],
      traces = [];
    for (let row = 0; row < 128; row++) {
      const rc = api.fetch(statement);
      if (rc === 100) break;
      check(rc, "fetch", 3, statement);
      const cells = metadata.map((column, index) =>
        readCell(statement, index + 1, [-2, -3, -4].includes(column.type), payloadBytes),
      );
      rows.push(cells.map((cell) => cell.value));
      traces.push(cells.map((cell) => cell.trace));
      assert.ok(row < 127, "Probe row limit");
    }
    const more = api.more(statement);
    assert.equal(more, 100, "Unexpected additional result set or native error");
    return { rows, metadata, traces };
  } finally {
    // A failed free must not leave retained pointers dangling. Dedicated process exits.
    const rc = api.free(3, statement);
    if (rc === 0)
      allocations.forEach((pointer) => {
        koffi.free(pointer);
      });
    else check(rc, "free-statement", 3, statement);
  }
}
const text = (value) => ({ kind: "text", value });
const binary = (value) => ({ kind: "binary", value });
let env,
  connection,
  connected = false;
let current = "bootstrap";
try {
  env = allocate(1, null);
  check(api.envAttr(env, 200, 3n, 0), "odbc-version", 1, env);
  if (process.argv.includes("--abi-only")) {
    evidence.abiOnly = true;
  } else {
    assert.equal(process.platform, "linux", "Native qualification targets Linux x64");
    assert.equal(process.arch, "x64");
    assert.ok([14, 15, 16, 17].includes(evidence.major));
    const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
    assert.ok(password && !/[;{}]/u.test(password), "Disposable password required");
    connection = allocate(2, env);
    const dsn = `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=master;UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
    assert.ok(dsn.length < 32767);
    const connectResult = api.connect(connection, null, wide(dsn), dsn.length, null, 0, [0], 0);
    // SUCCESS_WITH_INFO still establishes a live connection, even when a warning
    // is rejected below. Always disconnect it before freeing the DBC handle.
    connected = connectResult === 0 || connectResult === 1;
    if (connectResult === 1) {
      const records = diagnostics(2, connection);
      evidence.connectNotices = records;
      const contextOnly =
        records.length > 0 &&
        records.every((record) => record.state === "01000" && (record.native === 5701 || record.native === 5703));
      if (!contextOnly) check(connectResult, "connect", 2, connection);
    } else check(connectResult, "connect", 2, connection);
    const version = query(connection, "SELECT CONVERT(nvarchar(128),SERVERPROPERTY('ProductVersion')) AS version");
    assert.equal(Number(version.rows[0][0].split(".")[0]), evidence.major);
    evidence.serverVersion = version.rows[0][0];
    function probe(name, sql, values, expected, payloadBytes = 4096, expectedMetadata) {
      current = name;
      const result = query(connection, sql, values, payloadBytes);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].length, expected.length);
      result.rows[0].forEach((value, index) => {
        const exact =
          value === null
            ? expected[index] === null
            : Buffer.isBuffer(value)
              ? Buffer.isBuffer(expected[index]) && value.equals(expected[index])
              : value === expected[index];
        if (!exact) {
          const error = new Error("Value fidelity mismatch");
          error.evidence = {
            stage: "fidelity",
            column: index,
            actualLength: value?.length ?? null,
            expectedLength: expected[index]?.length ?? null,
            actualSha256: digest(value),
            expectedSha256: digest(expected[index]),
            metadata: result.metadata,
            traces: result.traces,
          };
          throw error;
        }
      });
      if (expectedMetadata) expectedMetadata(result.metadata);
      evidence.cases.push({
        name,
        status: "pass",
        metadata: result.metadata,
        values: result.rows[0].map((value) => ({
          null: value === null,
          length: value?.length ?? null,
          sha256: digest(value),
        })),
        traces: result.traces,
      });
    }
    // Both paths test long MAX values independent of any application's SQL renderer.
    const unicode = `${"aé漢😀".repeat(12000)}\0\0`;
    for (const payload of [4096, 4094, 6]) {
      probe(
        `prepared-nvarchar-unicode-${payload}`,
        "SELECT CONVERT(nvarchar(max),?) AS value",
        [text(unicode)],
        [unicode],
        payload,
      );
    }
    probe(
      "prepared-nvarchar-all-nul",
      "SELECT CONVERT(nvarchar(max),?) AS value",
      [text("\0".repeat(40000))],
      ["\0".repeat(40000)],
    );
    probe(
      "direct-nvarchar-trailing-nul",
      "SELECT REPLICATE(CONVERT(nvarchar(max),N'aé漢'),20000)+NCHAR(0)+NCHAR(0) AS value",
      [],
      [`${"aé漢".repeat(20000)}\0\0`],
    );
    probe(
      "direct-varchar-ascii",
      "SELECT REPLICATE(CONVERT(varchar(max),'abc'),14000)+CHAR(0)+CHAR(0) AS value",
      [],
      [`${"abc".repeat(14000)}\0\0`],
    );
    probe(
      "prepared-varchar-ascii",
      "SELECT CONVERT(varchar(max),?) AS value",
      [text(`${"ascii".repeat(8000)}\0\0`)],
      [`${"ascii".repeat(8000)}\0\0`],
    );
    if (evidence.major >= 15) {
      probe(
        "prepared-varchar-utf8",
        "SELECT CONVERT(varchar(max),? COLLATE Latin1_General_100_BIN2_UTF8) AS value",
        [text(unicode)],
        [unicode],
      );
      probe(
        "direct-varchar-utf8",
        "SELECT CONVERT(varchar(max),REPLICATE(CONVERT(nvarchar(max),N'aé漢'),14000) COLLATE Latin1_General_100_BIN2_UTF8)+CHAR(0)+CHAR(0) AS value",
        [],
        [`${"aé漢".repeat(14000)}\0\0`],
      );
    }
    probe(
      "text-null-empty-nul",
      "SELECT CONVERT(nvarchar(max),?) AS a,CONVERT(nvarchar(max),?) AS b,CONVERT(nvarchar(max),?) AS c",
      [text(null), text(""), text("x\0y\0")],
      [null, "", "x\0y\0"],
    );
    const bytes = Buffer.from(Array.from({ length: 40001 }, (_, index) => index % 256));
    probe(
      "binary-null-empty-nul-large",
      "SELECT CONVERT(varbinary(max),?) AS a,CONVERT(varbinary(max),?) AS b,CONVERT(varbinary(max),?) AS c",
      [binary(null), binary(Buffer.alloc(0)), binary(bytes)],
      [null, Buffer.alloc(0), bytes],
    );
    probe(
      "direct-binary",
      "SELECT CONVERT(varbinary(max),0x) AS a,CONVERT(varbinary(max),NULL) AS b,CONVERT(varbinary(max),0x0001000200) AS c",
      [],
      [Buffer.alloc(0), null, Buffer.from([0, 1, 0, 2, 0])],
    );
    probe(
      "exact-numeric-temporal",
      "SELECT CONVERT(decimal(38,10),?) AS d,CONVERT(bigint,?) AS hi,CONVERT(bigint,?) AS lo,CONVERT(datetime2(7),?) AS dt,CONVERT(datetimeoffset(7),?) AS dto",
      [
        text("1234567890123456789012345678.0123456789"),
        text("9223372036854775807"),
        text("-9223372036854775808"),
        text("2026-01-02 03:04:05.1234567"),
        text("2026-01-02 03:04:05.1234567 +05:30"),
      ],
      [
        "1234567890123456789012345678.0123456789",
        "9223372036854775807",
        "-9223372036854775808",
        "2026-01-02 03:04:05.1234567",
        "2026-01-02 03:04:05.1234567 +05:30",
      ],
      4096,
      (columns) => {
        assert.equal(columns[0].size, 38);
        assert.equal(columns[0].scale, 10);
      },
    );
  }
  evidence.status = "pass";
} catch (error) {
  evidence.status = "fail";
  // Deliberately omit native messages, SQL, input data, error.stack and cause.
  evidence.failure = { case: current, ...(error.evidence ?? { stage: "assertion-or-ffi" }) };
  process.exitCode = 1;
} finally {
  const cleanup = [];
  if (connected) cleanup.push({ stage: "disconnect", rc: api.disconnect(connection) });
  if (connection) cleanup.push({ stage: "free-connection", rc: api.free(2, connection) });
  if (env) cleanup.push({ stage: "free-environment", rc: api.free(1, env) });
  evidence.cleanup = cleanup;
  if (cleanup.some((entry) => entry.rc !== 0)) {
    evidence.status = "fail";
    process.exitCode = 1;
  }
  console.log(JSON.stringify(evidence, null, 2));
}
