import { Buffer } from "node:buffer";
import { describe, it, strict } from "poku";
import {
  decodeSqlServerNativeValue,
  encodeSqlServerParameter,
  formatSqlServerNativeDate,
  validateSqlServerTemporal,
} from "../src/decoding.js";
import { requireSqlServerNativeType } from "../src/native-types.js";
import { defaultSqlServerTypePolicy as policy } from "../src/type-policy.js";

const descriptor = (databaseType: string, nullable = false) => ({ databaseType, nullable, type: "unknown" as const });
const encode = (value: unknown, type: string) => encodeSqlServerParameter(value, descriptor(type), policy);
await describe("SQL Server lossless native codecs", async () => {
  await it("rejects precision loss before sending numeric values", () => {
    strict.equal(encode("-9223372036854775808", "bigint"), "-9223372036854775808");
    strict.equal(encode("0", "decimal(38,0)"), "0");
    strict.equal(encode("-0.0", "money"), "0.0000");
    for (const [value, type] of [
      [256, "tinyint"],
      [-1, "tinyint"],
      [9007199254740992, "bigint"],
      ["1.001", "decimal(4,2)"],
      [Infinity, "float"],
      ["214748.3648", "smallmoney"],
    ] as const)
      strict.throws(() => encode(value, type));
    strict.throws(() => decodeSqlServerNativeValue(1.2, descriptor("decimal(38,10)"), policy), /lossy/);
    strict.equal(decodeSqlServerNativeValue("1.2300000000", descriptor("decimal(38,10)"), policy), "1.2300000000");
  });
  await it("validates physical text code pages and byte limits independently of Unicode storage", () => {
    strict.equal(encode("é€", "varchar(2) COLLATE SQL_Latin1_General_CP1_CI_AS"), "é€");
    strict.equal(encode("😀😀", "varchar(8) COLLATE Latin1_General_100_CI_AS_SC_UTF8"), "😀😀");
    strict.throws(() => encode("😀😀é", "varchar(8) COLLATE Latin1_General_100_CI_AS_SC_UTF8"), /length/);
    strict.throws(() => encode("漢", "varchar(8) COLLATE SQL_Latin1_General_CP1_CI_AS"), /representable/);
    strict.throws(() => encode("é", "varchar(8)"), /collation/);
    strict.equal(encode("漢😀", "nvarchar(3)"), "漢😀");
    strict.throws(() => encode("😀😀", "nvarchar(3)"), /length/);
    strict.throws(() => encode("\ud800", "varchar(4) COLLATE Latin1_General_100_CI_AS_SC_UTF8"), /surrogate/);
    strict.equal(encode("\0", "nvarchar(1)"), "\0");
  });
  await it("keeps 100ns values, early years and normalized offset instants", () => {
    const native = new Date("0099-01-02T03:04:05.123Z");
    Object.assign(native, { nanosecondsDelta: 0.0004567 });
    strict.equal(
      formatSqlServerNativeDate(native, requireSqlServerNativeType("datetime2(7)")),
      "0099-01-02T03:04:05.1234567",
    );
    strict.equal(
      formatSqlServerNativeDate(native, requireSqlServerNativeType("datetimeoffset(7)")),
      "0099-01-02T03:04:05.1234567Z",
    );
    strict.equal(formatSqlServerNativeDate(native, requireSqlServerNativeType("time(7)")), "03:04:05.1234567");
    strict.equal(formatSqlServerNativeDate(native, requireSqlServerNativeType("date")), "0099-01-02");
    strict.throws(() => formatSqlServerNativeDate(new Date(), requireSqlServerNativeType("datetime2")), /evidence/);
    strict.throws(() => formatSqlServerNativeDate(native, requireSqlServerNativeType("time(3)")), /scale/);
    strict.equal(
      validateSqlServerTemporal("0001-01-01T00:00:00.0000001", requireSqlServerNativeType("datetime2(7)")),
      "0001-01-01T00:00:00.0000001",
    );
    strict.equal(encode("2024-01-02T03:04:05.1234567+05:45", "datetimeoffset(7)"), "2024-01-02T03:04:05.1234567+05:45");
  });
  await it("rejects invalid calendars, scales, timezone conversions and legacy rounding", () => {
    for (const [value, type] of [
      ["2023-02-29", "date"],
      ["0000-01-01", "date"],
      ["2024-01-01T24:00:00", "datetime2"],
      ["2024-01-01T00:00:00Z", "datetime2"],
      ["2024-01-01T00:00:00", "datetimeoffset"],
      ["2024-01-01T00:00:00+14:01", "datetimeoffset"],
      ["2024-01-01T00:00:00.1234", "datetime2(3)"],
      ["1752-01-01T00:00:00", "datetime"],
      ["2024-01-01T00:00:00.001", "datetime"],
      ["2024-01-01T00:00:01", "smalldatetime"],
    ] as const)
      strict.throws(() => encode(value, type));
    strict.equal(encode("2024-01-01T00:00:00.003", "datetime"), "2024-01-01T00:00:00.003");
  });
  await it("copies binary buffers and rejects missing or incompatible metadata", () => {
    const nativeBuffer = Buffer.from([0, 255]);
    const decoded = decodeSqlServerNativeValue(nativeBuffer, descriptor("varbinary(max)"), policy) as Uint8Array;
    const encoded = encode(nativeBuffer, "varbinary(max)");
    nativeBuffer[0] = 42;
    strict.deepEqual([...decoded], [0, 255]);
    strict.equal(encoded, "00FF");
    strict.equal(encode(new Uint8Array(), "varbinary(max)"), "");
    const original = Uint8Array.of(0, 255),
      copy = encode(original, "varbinary(max)");
    original[0] = 42;
    strict.equal(copy, "00FF");
    strict.throws(() => encode(Uint8Array.of(0, 255), "binary(1)"), /length/);
    strict.throws(() => encode(Uint8Array.of(0, 255), "rowversion"), /assigned/);
    strict.throws(() => encode("nope", "uniqueidentifier"), /uniqueidentifier/);
    strict.throws(() => encode(null, "bigint"), /nullable/);
    strict.equal(encodeSqlServerParameter(null, descriptor("bigint", true), policy), null);
    strict.throws(() => encodeSqlServerParameter("1", { nullable: false, type: "string" }, policy), /metadata/);
  });
  await it("checks native temporal augmentation and actual calendar bounds before formatting", () => {
    const type = requireSqlServerNativeType("datetime2(7)");
    for (const value of [null, "2024-01-01", new Date(NaN), new Date("0000-01-01"), new Date("+010000-01-01")])
      strict.throws(() => formatSqlServerNativeDate(value, type), /valid in-range/);
    for (const nanosecondsDelta of [undefined, NaN, -0.001, 0.001, 0.00000015]) {
      const value = Object.assign(new Date("2024-01-01T00:00:00Z"), { nanosecondsDelta });
      strict.throws(() => formatSqlServerNativeDate(value, type), /fraction|100ns/);
    }
    const legacy = Object.assign(new Date("2024-01-01T00:00:00.007Z"), { nanosecondsDelta: 0 });
    strict.equal(formatSqlServerNativeDate(legacy, requireSqlServerNativeType("datetime")), "2024-01-01T00:00:00.007");
    const minute = Object.assign(new Date("2024-01-01T00:00:00Z"), { nanosecondsDelta: 0 });
    strict.equal(formatSqlServerNativeDate(minute, requireSqlServerNativeType("smalldatetime")), "2024-01-01T00:00:00");
  });
  await it("rejects unrepresentable temporal text and accepts exact trailing-zero precision", () => {
    for (const [value, type] of [
      ["0".repeat(65), "date"],
      ["2024/01/01", "date"],
      ["2024-13-01", "date"],
      ["2024-01-01T00:60:00", "datetime2"],
      ["23:59:60", "time"],
      ["0001-01-01T00:00:00+14:00", "datetimeoffset"],
      ["9999-12-31T23:59:59-14:00", "datetimeoffset"],
      ["2024-01-01T00:00:00+15:00", "datetimeoffset"],
      ["2024-01-01T00:00:00+00:60", "datetimeoffset"],
      ["1899-12-31T00:00:00", "smalldatetime"],
      ["2079-06-07T00:00:00", "smalldatetime"],
    ] as const)
      strict.throws(() => encode(value, type));
    strict.equal(encode("12:34:56.1200000", "time(2)"), "12:34:56.12");
    strict.equal(encode("2024-01-01T00:00:00Z", "datetimeoffset(0)"), "2024-01-01T00:00:00Z");
    strict.equal(encode("2024-01-01T00:00:00.123-03:30", "datetimeoffset(3)"), "2024-01-01T00:00:00.123-03:30");
  });
  await it("implements explicit Date and Decimal policies without weakening the default exact codecs", () => {
    const date = new Date("2024-01-02T03:04:05.123Z"),
      datePolicy = { ...policy, temporal: "Date" as const };
    for (const [type, expected] of [
      ["date", "2024-01-02"],
      ["time(3)", "03:04:05.123"],
      ["datetime2(3)", "2024-01-02T03:04:05.123"],
      ["datetimeoffset(3)", "2024-01-02T03:04:05.123Z"],
    ] as const)
      strict.equal(encodeSqlServerParameter(date, descriptor(type), datePolicy), expected);
    const copy = decodeSqlServerNativeValue(date, descriptor("datetime2"), datePolicy);
    strict.notEqual(copy, date);
    strict.deepEqual(copy, date);
    strict.deepEqual(
      decodeSqlServerNativeValue("2024-01-01", descriptor("date"), datePolicy),
      new Date("2024-01-01T00:00:00Z"),
    );
    strict.throws(() => encode(date, "datetime2"), /policy/);
    const decimalPolicy = { ...policy, decimal: "Decimal" as const };
    strict.equal(
      encodeSqlServerParameter({ value: "1.25" }, descriptor("decimal(5,2)"), decimalPolicy, () => "1.25"),
      "1.25",
    );
    strict.deepEqual(
      decodeSqlServerNativeValue("1.25", descriptor("decimal(5,2)"), decimalPolicy, (value) => ({ value })),
      { value: "1.25" },
    );
    strict.throws(() => decodeSqlServerNativeValue("1.25", descriptor("decimal(5,2)"), decimalPolicy), /codec/);
    const numeric = { ...policy, decimal: "number" as const };
    strict.equal(encodeSqlServerParameter(1.25, descriptor("decimal(5,2)"), numeric), "1.25");
    strict.equal(decodeSqlServerNativeValue("1.25", descriptor("decimal(5,2)"), numeric), 1.25);
    strict.throws(
      () => decodeSqlServerNativeValue("99999999999999999999999999999999999999", descriptor("decimal(38,0)"), numeric),
      /number policy/,
    );
  });
  await it("keeps primitive type errors and missing result metadata fail closed", () => {
    strict.equal(encode(true, "bit"), true);
    strict.equal(encode(1.5, "real"), 1.5);
    strict.equal(encode(42n, "int"), "42");
    strict.equal(
      encode("A0B1C2D3-E4F5-1234-ABCD-0123456789AB", "uniqueidentifier"),
      "A0B1C2D3-E4F5-1234-ABCD-0123456789AB",
    );
    for (const [value, type] of [
      ["yes", "bit"],
      [1, "nvarchar(4)"],
      ["bytes", "varbinary(4)"],
      [1, "sql_variant"],
      [1.2, "int"],
      [1.25, "decimal(5,2)"],
      [Number.MAX_SAFE_INTEGER + 1, "float"],
    ] as const)
      strict.throws(() => encode(value, type));
    strict.throws(() => decodeSqlServerNativeValue(1, { type: "number", nullable: false }, policy), /metadata/);
    strict.equal(decodeSqlServerNativeValue(null, descriptor("date", true), policy), null);
    strict.equal(decodeSqlServerNativeValue("text", descriptor("nvarchar(4)"), policy), "text");
  });
  await it("normalizes counted ODBC temporal strings without passing 100ns fractions through Date", () => {
    for (const [value, type, expected] of [
      ["0001-01-01 00:00:00.0000001", "datetime2(7)", "0001-01-01T00:00:00.0000001"],
      ["0099-12-31 00:00:00.1234567 +05:45", "datetimeoffset(7)", "0099-12-30T18:15:00.1234567Z"],
      ["1969-12-31 23:00:00.0000001 -03:30", "datetimeoffset(7)", "1970-01-01T02:30:00.0000001Z"],
      ["9999-12-31 23:59:59.997", "datetime", "9999-12-31T23:59:59.997"],
      ["2079-06-06 23:59:00", "smalldatetime", "2079-06-06T23:59:00"],
      ["03:04:05.1234567", "time(7)", "03:04:05.1234567"],
    ] as const)
      strict.equal(decodeSqlServerNativeValue(value, descriptor(type), policy), expected);
    const datePolicy = { ...policy, temporal: "Date" as const };
    strict.deepEqual(
      decodeSqlServerNativeValue("03:04:05.1234567", descriptor("time(7)"), datePolicy),
      new Date("1970-01-01T03:04:05.123Z"),
    );
    strict.deepEqual(
      decodeSqlServerNativeValue("0099-12-31 00:00:00.1234567", descriptor("datetime2(7)"), datePolicy),
      new Date("0099-12-31T00:00:00.123Z"),
    );
    strict.equal(decodeSqlServerNativeValue("1", descriptor("bit"), policy), true);
    strict.equal(decodeSqlServerNativeValue("0", descriptor("bit"), policy), false);
    strict.throws(() => decodeSqlServerNativeValue("true", descriptor("bit"), policy), /zero or one/);
    strict.equal(
      decodeSqlServerNativeValue('{"n":9007199254740993}', descriptor("json"), policy),
      '{"n":9007199254740993}',
    );
    strict.throws(() => decodeSqlServerNativeValue("bad JSON", descriptor("json"), policy), /invalid JSON/);
  });
});
