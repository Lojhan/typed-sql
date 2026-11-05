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
    const original = Uint8Array.of(0, 255),
      copy = encode(original, "varbinary(max)") as Uint8Array;
    original[0] = 42;
    strict.deepEqual([...copy], [0, 255]);
    strict.throws(() => encode(copy, "binary(1)"), /length/);
    strict.throws(() => encode(copy, "rowversion"), /assigned/);
    strict.throws(() => encode("nope", "uniqueidentifier"), /uniqueidentifier/);
    strict.throws(() => encode(null, "bigint"), /nullable/);
    strict.equal(encodeSqlServerParameter(null, descriptor("bigint", true), policy), null);
    strict.throws(() => encodeSqlServerParameter("1", { nullable: false, type: "string" }, policy), /metadata/);
  });
});
