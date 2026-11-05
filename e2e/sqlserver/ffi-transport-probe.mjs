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
  attribute: fn("SQLColAttributeW", [p, "uint16_t", "uint16_t", p, "int16_t", out("int16_t"), out("intptr")]),
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
const digest = (value) => {
  if (value === null) return null;
  if (typeof value === "number") {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleLE(value);
    return createHash("sha256").update(bytes).digest("hex");
  }
  return createHash("sha256").update(value).digest("hex");
};
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
        binary ? -4 : -9,
        // SQL_SS_LENGTH_UNLIMITED=0 selects NVARCHAR(MAX), independent of value length.
        binary ? Math.max(1, value.value?.length ?? 0) : 0,
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
function readCell(statement, ordinal, binary, payloadBytes, floatType) {
  if (floatType !== undefined) {
    const size = floatType === 7 ? 4 : 8;
    const bytes = Buffer.alloc(size);
    const indicator = [0];
    const rc = api.get(statement, ordinal, floatType, bytes, size, indicator);
    check(rc, "get-binary-float", 3, statement);
    const length = Number(indicator[0]);
    const trace = [{ rc, indicator: length, target: floatType, bits: bytes.toString("hex") }];
    if (length === -1) return { value: null, trace };
    assert.equal(length, size, "Binary floating-point indicator disagrees with ABI");
    const value = floatType === 7 ? bytes.readFloatLE() : bytes.readDoubleLE();
    assert.ok(Number.isFinite(value), "Non-finite native floating-point result");
    return { value, trace };
  }
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
function destroyStatement(statement, allocations) {
  // A failed free must not leave retained pointers dangling. Dedicated process exits.
  const rc = api.free(3, statement);
  if (rc === 0)
    allocations.forEach((pointer) => {
      koffi.free(pointer);
    });
  else check(rc, "free-statement", 3, statement);
}
function query(connection, text, values = [], payloadBytes = 4096, reusable) {
  assert.ok(text.length < 1_000_000);
  const statement = reusable?.statement ?? allocate(3, connection);
  const allocations = reusable?.allocations ?? [];
  try {
    if (values.length) {
      if (!reusable?.prepared) {
        check(api.prepare(statement, wide(text), text.length), "prepare", 3, statement);
        if (reusable) {
          reusable.prepared = true;
          reusable.prepares++;
        }
      }
      bind(statement, values, allocations);
      // Stable input/indicator allocations survive execution, GC and all result draining.
      globalThis.gc?.();
      check(api.execute(statement), "execute", 3, statement);
    } else check(api.direct(statement, wide(text), text.length), "exec-direct", 3, statement);
    const count = [0];
    let commandStages = 0;
    check(api.columns(statement, count), "result-column-count", 3, statement);
    while (count[0] === 0) {
      assert.ok(++commandStages <= 128, "Command stage limit");
      check(api.more(statement), "advance-to-rowset", 3, statement);
      check(api.columns(statement, count), "result-column-count", 3, statement);
    }
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
      const typeName = Buffer.alloc(258);
      const typeNameBytes = [0];
      check(
        api.attribute(statement, ordinal, 14, typeName, typeName.length, typeNameBytes, [0]),
        "column-type-name",
        3,
        statement,
      );
      assert.ok(typeNameBytes[0] >= 0 && typeNameBytes[0] < typeName.length && typeNameBytes[0] % 2 === 0);
      metadata.push({
        typeName: typeName.subarray(0, typeNameBytes[0]).toString("utf16le"),
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
        readCell(
          statement,
          index + 1,
          [-2, -3, -4].includes(column.type),
          payloadBytes,
          column.type === 7 ? 7 : [6, 8].includes(column.type) ? 8 : undefined,
        ),
      );
      rows.push(cells.map((cell) => cell.value));
      traces.push(cells.map((cell) => cell.trace));
      assert.ok(row < 127, "Probe row limit");
    }
    for (;;) {
      const more = api.more(statement);
      if (more === 100) break;
      check(more, "drain-command-results", 3, statement);
      check(api.columns(statement, count), "result-column-count", 3, statement);
      assert.equal(count[0], 0, "Unexpected additional rowset");
      assert.ok(++commandStages <= 128, "Command stage limit");
    }
    return { rows, metadata, traces, commandStages };
  } finally {
    if (!reusable) destroyStatement(statement, allocations);
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
              : typeof value === "number"
                ? Object.is(value, expected[index])
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
          ...(name.startsWith("temporal-") && typeof value === "string"
            ? { format: value.replace(/[0-9]/gu, "d") }
            : {}),
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
      for (const payload of [4096, 4094, 6]) {
        probe(
          `prepared-varchar-utf8-${payload}`,
          "SELECT CONVERT(varchar(max),? COLLATE Latin1_General_100_BIN2_UTF8) AS value",
          [text(unicode)],
          [unicode],
          payload,
        );
        probe(
          `direct-varchar-utf8-${payload}`,
          "SELECT CONVERT(varchar(max),REPLICATE(CONVERT(nvarchar(max),N'aé漢😀'),12000) COLLATE Latin1_General_100_BIN2_UTF8)+CHAR(0)+CHAR(0) AS value",
          [],
          [unicode],
          payload,
        );
      }
    }
    // Prepare once, replace data/indicator pointers without changing the native
    // parameter type, fully drain each execution, and retain old pointers until free.
    const reusable = { statement: allocate(3, connection), allocations: [], prepared: false, prepares: 0 };
    try {
      let baseline;
      for (const [index, value] of ["short", unicode, "", null, unicode].entries()) {
        current = `prepared-rebind-${index}`;
        const result = query(connection, "SELECT CONVERT(nvarchar(max),?) AS value", [text(value)], 4096, reusable);
        assert.equal(result.rows.length, 1);
        assert.ok(result.rows[0][0] === value, "Rebind fidelity mismatch");
        if (baseline) assert.deepEqual(result.metadata, baseline);
        baseline = result.metadata;
        evidence.cases.push({
          name: current,
          status: "pass",
          metadata: result.metadata,
          values: [{ null: value === null, length: value?.length ?? null, sha256: digest(result.rows[0][0]) }],
          prepares: reusable.prepares,
          traces: result.traces,
        });
      }
      assert.equal(reusable.prepares, 1);
    } finally {
      destroyStatement(reusable.statement, reusable.allocations);
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
    // ODBC decimal text conversion is not an oracle for binary floating point.
    // These literals round to fixed known IEEE754 values independently of the driver.
    probe(
      "native-binary-real-float",
      "SELECT CONVERT(real,?) AS r,CONVERT(float(53),?) AS d,CONVERT(real,?) AS rmax,CONVERT(float(53),?) AS dsmall,CONVERT(float(53),NULL) AS absent",
      [
        text("1.00000011920928955078125"),
        text("1.0000000000000002"),
        text("3.4028234663852886e38"),
        text("2.2250738585072014e-308"),
      ],
      [1 + 2 ** -23, 1.0000000000000002, Math.fround(3.4028234663852886e38), 2.2250738585072014e-308, null],
      4096,
      (columns) => {
        assert.ok(columns.slice(0, 4).every((column) => [6, 7, 8].includes(column.type)));
      },
    );
    probe(
      "native-bit-guid-xml",
      "SELECT CONVERT(bit,?) AS yes,CONVERT(bit,?) AS no,CONVERT(uniqueidentifier,?) AS guid,CONVERT(xml,?) AS doc",
      [text("1"), text("0"), text("01234567-0123-0123-0123-012345678901"), text('<r a="x">é漢😀</r>')],
      ["1", "0", "01234567-0123-0123-0123-012345678901", '<r a="x">é漢😀</r>'],
    );
    if (evidence.major === 17) {
      const json = '{"text":"é漢😀","n":9007199254740993,"array":[null,true]}';
      probe("native-json", "SELECT CONVERT(json,?) AS doc", [text(json)], [json]);
    }
    // Fixed fractions have no rounding ambiguity; every supported scale is observed.
    for (let scale = 0; scale <= 7; scale++) {
      const fraction = scale ? `.${"1234567".slice(0, scale)}` : "";
      const time = `03:04:05${fraction}`;
      const dateTime = `1969-12-31 ${time}`;
      const offset = `${dateTime} -05:30`;
      probe(
        `temporal-scale-${scale}`,
        `SELECT CONVERT(time(${scale}),?) AS t,CONVERT(datetime2(${scale}),?) AS dt,CONVERT(datetimeoffset(${scale}),?) AS dto`,
        [text(time), text(dateTime), text(offset)],
        [time, dateTime, offset],
        4096,
        (columns) => {
          assert.ok(columns.every((column) => column.scale === scale));
        },
      );
    }
    for (const date of ["0001-01-01", "0099-12-31", "1969-12-31", "9999-12-31"]) {
      const dt = `${date} 00:00:00.0000001`;
      probe(
        `temporal-year-${date.slice(0, 4)}`,
        "SELECT CONVERT(date,?) AS d,CONVERT(datetime2(7),?) AS dt,CONVERT(datetimeoffset(7),?) AS dto",
        [text(date), text(dt), text(`${dt} +00:00`)],
        [date, dt, `${dt} +00:00`],
      );
    }
    for (const offset of ["-14:00", "+14:00"]) {
      const dt = `2026-01-02 03:04:05.1234567 ${offset}`;
      probe(`temporal-offset-${offset}`, "SELECT CONVERT(datetimeoffset(7),?) AS dto", [text(dt)], [dt]);
    }
    probe(
      "temporal-legacy-ranges",
      "SELECT CONVERT(datetime,?) AS min,CONVERT(datetime,?) AS max,CONVERT(smalldatetime,?) AS smallmin,CONVERT(smalldatetime,?) AS smallmax",
      [
        text("1753-01-01 00:00:00.000"),
        text("9999-12-31 23:59:59.997"),
        text("1900-01-01 00:00:00"),
        text("2079-06-06 23:59:00"),
      ],
      ["1753-01-01 00:00:00.000", "9999-12-31 23:59:59.997", "1900-01-01 00:00:00", "2079-06-06 23:59:00"],
    );
    current = "native-rowversion-command-stages";
    const rowversion = query(
      connection,
      "DECLARE @t TABLE(id int,rv rowversion);INSERT INTO @t(id) VALUES(1);SELECT rv,CONVERT(binary(8),rv) AS expected FROM @t",
    );
    assert.equal(rowversion.rows.length, 1);
    assert.ok(rowversion.rows[0].every((value) => Buffer.isBuffer(value) && value.length === 8));
    assert.ok(rowversion.rows[0][0].equals(rowversion.rows[0][1]));
    evidence.cases.push({
      name: current,
      status: "pass",
      metadata: rowversion.metadata,
      commandStages: rowversion.commandStages,
      traces: rowversion.traces,
    });
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
