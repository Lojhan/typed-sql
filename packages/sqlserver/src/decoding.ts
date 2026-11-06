import type { QueryValueDescriptor } from "@typed-sql/core";
import { sqlServerEncodedTextLength } from "./collation.js";
import {
  requireSqlServerNativeType,
  SQLSERVER_INTEGER_BOUNDS,
  type SqlServerNativeType,
  validateSqlServerDecimal,
} from "./native-types.js";
import type { SqlServerTypePolicy } from "./type-policy.js";
export interface SqlServerNativeDate extends Date {
  readonly nanosecondsDelta: number;
}
const temporalNames = new Set(["date", "time", "datetime", "datetime2", "datetimeoffset", "smalldatetime"]);
export function isSqlServerTemporal(type: SqlServerNativeType): boolean {
  return temporalNames.has(type.name);
}
/** Reconstruct the native driver's exact 100ns fraction; Date.toISOString alone is insufficient. */
export function formatSqlServerNativeDate(value: unknown, target: SqlServerNativeType): string {
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime()) ||
    value.getUTCFullYear() < 1 ||
    value.getUTCFullYear() > 9999
  )
    throw new TypeError("SQL Server temporal transport requires a valid in-range native Date");
  if (!Object.hasOwn(value, "nanosecondsDelta"))
    throw new TypeError("SQL Server native temporal precision evidence is missing");
  const delta = (value as SqlServerNativeDate).nanosecondsDelta;
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta < 0 || delta >= 0.001)
    throw new TypeError("Invalid SQL Server nanosecond fraction");
  const nanos = Math.round(delta * 1e9);
  if (!Number.isSafeInteger(nanos) || nanos % 100 !== 0 || Math.abs(delta * 1e9 - nanos) > 0.00001)
    throw new TypeError("SQL Server temporal fraction is not an exact 100ns tick");
  const full = value
    .toISOString()
    .replace(/\.(\d{3})Z$/u, (_, millis: string) => `.${millis}${String(nanos / 100).padStart(4, "0")}Z`);
  if (target.name === "date") return full.slice(0, 10);
  const scale = target.scale ?? (target.name === "datetime" ? 3 : target.name === "smalldatetime" ? 0 : 7);
  const body = target.name === "time" ? full.slice(11, -1) : full.slice(0, -1);
  const [whole, fraction = ""] = body.split(".");
  if (/[1-9]/u.test(fraction.slice(scale)))
    throw new TypeError("SQL Server native temporal value disagrees with its declared scale");
  return `${whole}${scale ? `.${fraction.slice(0, scale)}` : ""}${target.name === "datetimeoffset" ? "Z" : ""}`;
}
function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    year >= 1 &&
    year <= 9999 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
/** Validate ISO text before dispatch, retaining seven fractional digits and explicit UTC semantics. */
export function validateSqlServerTemporal(value: string, type: SqlServerNativeType): string {
  if (value.length > 64) throw new TypeError("SQL Server temporal input exceeds its canonical bound");
  const date = type.name === "date",
    time = type.name === "time",
    offset = type.name === "datetimeoffset";
  const pattern = date
    ? /^(\d{4})-(\d{2})-(\d{2})$/u
    : time
      ? /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/u
      : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})?$/u;
  const match = pattern.exec(value);
  if (!match) throw new TypeError("SQL Server temporal input requires canonical ISO text");
  if (!time && !validDate(Number(match[1]), Number(match[2]), Number(match[3])))
    throw new RangeError("SQL Server temporal calendar date is invalid");
  if (date) return value;
  const start = time ? 1 : 4;
  const hour = Number(match[start]),
    minute = Number(match[start + 1]),
    second = Number(match[start + 2]);
  if (hour > 23 || minute > 59 || second > 59) throw new RangeError("SQL Server temporal clock value is invalid");
  const fraction = match[time ? 4 : 7] ?? "";
  const scale = type.scale ?? (type.name === "datetime" ? 3 : type.name === "smalldatetime" ? 0 : 7);
  if (fraction.length > scale && /[1-9]/u.test(fraction.slice(scale)))
    throw new RangeError("SQL Server temporal input requires precision rounding");
  const zone = time ? undefined : match[8];
  if (offset && !zone) throw new TypeError("SQL Server datetimeoffset requires an explicit UTC offset");
  if (!offset && zone)
    throw new TypeError("SQL Server wall-time input must not contain an implicit timezone conversion");
  if (zone && zone !== "Z") {
    const hours = Number(zone.slice(1, 3)),
      minutes = Number(zone.slice(4, 6));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0))
      throw new RangeError("SQL Server UTC offset exceeds fourteen hours");
    const millis = Date.parse(value);
    if (!Number.isFinite(millis) || new Date(millis).getUTCFullYear() < 1 || new Date(millis).getUTCFullYear() > 9999)
      throw new RangeError("SQL Server UTC-normalized instant is out of range");
  }
  if (type.name === "datetime" && Number(match[1]) < 1753)
    throw new RangeError("SQL Server datetime begins in year 1753");
  if (type.name === "smalldatetime" && (value < "1900-01-01" || value > "2079-06-06T23:59:59"))
    throw new RangeError("SQL Server smalldatetime input is out of range");
  if (type.name === "datetime" && ![0, 3, 7].includes(Number(fraction.padEnd(3, "0").slice(0, 3)) % 10))
    throw new RangeError("SQL Server datetime input would round to a different millisecond");
  if (type.name === "smalldatetime" && second !== 0)
    throw new RangeError("SQL Server smalldatetime input would round seconds");
  const prefix = time ? value.slice(0, 8) : value.slice(0, 19);
  return `${prefix}${scale ? `.${fraction.slice(0, scale).padEnd(scale, "0")}` : ""}${zone ?? ""}`;
}
/** Normalize counted ODBC temporal text without discarding its seven-digit fraction. */
export function normalizeSqlServerTemporalText(value: string, target: SqlServerNativeType): string {
  const canonical = value.replace(/^(\d{4}-\d{2}-\d{2}) /u, "$1T").replace(/ ([+-]\d{2}:\d{2})$/u, "$1");
  const validated = validateSqlServerTemporal(canonical, target);
  if (target.name !== "datetimeoffset") return validated;
  const instant = new Date(validated);
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/u.exec(validated)?.[1];
  if (!Number.isFinite(instant.getTime())) throw new TypeError("Invalid SQL Server native datetimeoffset text");
  return `${instant.toISOString().slice(0, 19)}${fraction ? `.${fraction}` : ""}Z`;
}
export function encodeSqlServerParameter(
  value: unknown,
  descriptor: QueryValueDescriptor,
  policy: SqlServerTypePolicy,
  decimal?: (value: unknown) => string,
): unknown {
  if (descriptor.databaseType === undefined)
    throw new TypeError(
      "SQL Server compiled parameters require physical native target metadata; regenerate with a compatible compiler/core",
    );
  const target = requireSqlServerNativeType(descriptor.databaseType);
  if (value === null) {
    if (!descriptor.nullable) throw new TypeError("SQL Server parameter is not nullable");
    return null;
  }
  const bounds = SQLSERVER_INTEGER_BOUNDS[target.name];
  if (bounds) {
    let integer: bigint;
    if (typeof value === "bigint") integer = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) integer = BigInt(value);
    else if (typeof value === "string" && /^-?\d+$/u.test(value) && value.length < 32) integer = BigInt(value);
    else throw new TypeError("SQL Server integer parameter requires an exact integer");
    if (integer < bounds[0] || integer > bounds[1])
      throw new RangeError("SQL Server integer parameter exceeds its native range");
    return integer.toString();
  }
  if (["decimal", "money", "smallmoney"].includes(target.name)) {
    const text =
      typeof value === "string"
        ? value
        : typeof value === "number" && policy.decimal === "number" && Number.isFinite(value)
          ? String(value)
          : policy.decimal === "Decimal" && decimal
            ? decimal(value)
            : undefined;
    if (text === undefined)
      throw new TypeError("SQL Server exact decimal input requires a matching string or explicit Decimal codec");
    return validateSqlServerDecimal(text, target);
  }
  if (isSqlServerTemporal(target)) {
    const text =
      value instanceof Date && policy.temporal === "Date"
        ? target.name === "date"
          ? value.toISOString().slice(0, 10)
          : target.name === "time"
            ? value.toISOString().slice(11, -1)
            : target.name === "datetimeoffset"
              ? value.toISOString()
              : value.toISOString().slice(0, -1)
        : value;
    if (typeof text !== "string") throw new TypeError("SQL Server temporal input does not match its policy");
    return validateSqlServerTemporal(text, target);
  }
  if (target.name === "bit") {
    if (typeof value !== "boolean") throw new TypeError("SQL Server BIT parameter requires Boolean");
    return value;
  }
  if (target.name === "float" || target.name === "real") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    )
      throw new RangeError("SQL Server floating-point parameter cannot preserve this number");
    return value;
  }
  if (["binary", "varbinary", "image", "rowversion"].includes(target.name)) {
    if (!(value instanceof Uint8Array)) throw new TypeError("SQL Server binary parameter requires bytes");
    if (target.name === "rowversion")
      throw new TypeError("SQL Server rowversion cannot be assigned as an ordinary value");
    if (typeof target.length === "number" && value.length > target.length)
      throw new RangeError("SQL Server binary parameter exceeds its native length");
    let hex = "";
    for (const byte of value) hex += byte.toString(16).padStart(2, "0").toUpperCase();
    return hex;
  }
  if (target.name === "sql_variant")
    throw new TypeError("SQL Server sql_variant input requires an explicit qualified codec");
  if (typeof value !== "string") throw new TypeError("SQL Server text parameter requires string transport");
  if (
    target.name === "uniqueidentifier" &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  )
    throw new TypeError("Invalid SQL Server uniqueidentifier");
  const length = ["varchar", "char", "text"].includes(target.name)
    ? sqlServerEncodedTextLength(value, target.collation)
    : value.length;
  if (typeof target.length === "number" && length > target.length)
    throw new RangeError("SQL Server text parameter exceeds its native length");
  return value;
}
export function decodeSqlServerNativeValue(
  value: unknown,
  descriptor: QueryValueDescriptor,
  policy: SqlServerTypePolicy,
  decimal?: (value: string) => unknown,
): unknown {
  if (value === null) return null;
  if (descriptor.databaseType === undefined)
    throw new TypeError("SQL Server compiled columns require physical native target metadata");
  const target = requireSqlServerNativeType(descriptor.databaseType);
  if (isSqlServerTemporal(target)) {
    if (typeof value === "string") {
      const text = normalizeSqlServerTemporalText(value, target);
      if (policy.temporal !== "Date") return text;
      const iso =
        target.name === "time"
          ? `1970-01-01T${text}Z`
          : target.name === "date"
            ? `${text}T00:00:00Z`
            : target.name === "datetimeoffset"
              ? text
              : `${text}Z`;
      const date = new Date(iso);
      if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid SQL Server Date-policy text");
      return date;
    }
    if (policy.temporal === "Date") {
      if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
        throw new TypeError("SQL Server temporal transport must return Date");
      return new Date(value.getTime());
    }
    return formatSqlServerNativeDate(value, target);
  }
  if (["decimal", "money", "smallmoney"].includes(target.name)) {
    if (typeof value !== "string")
      throw new TypeError("SQL Server exact decimal transport returned a lossy value; enable native numeric strings");
    const text = validateSqlServerDecimal(value, target);
    if (policy.decimal === "Decimal") {
      if (!decimal) throw new TypeError("SQL Server Decimal policy requires a decimal codec");
      return decimal(text);
    }
    if (policy.decimal === "number") {
      const number = Number(text);
      if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)))
        throw new RangeError("SQL Server decimal cannot satisfy the number policy");
      return number;
    }
    return text;
  }
  if (target.name === "bit" && typeof value === "string") {
    if (value === "1") return true;
    if (value === "0") return false;
    throw new TypeError("SQL Server BIT text must be zero or one");
  }
  if (target.name === "json") {
    if (typeof value !== "string") throw new TypeError("SQL Server JSON text wire requires string transport");
    try {
      JSON.parse(value);
    } catch {
      throw new TypeError("SQL Server JSON text wire returned invalid JSON");
    }
  }
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  return value;
}
