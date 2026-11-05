import { type DuckDBType, duckDBAsciiFold, formatDuckDBType } from "./native-types.js";
import { type DuckDBTypePolicy, defaultDuckDBTypePolicy, isKnownDuckDBType } from "./type-policy.js";
export class DuckDBValueError extends TypeError {
  readonly code = "DUCKDB_VALUE";
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`DuckDB value at ${path}: ${message}`);
    this.name = "DuckDBValueError";
  }
}
const fail = (path: string, message: string): never => {
  throw new DuckDBValueError(path, message);
};
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(path, "expected native object");
  return value as Record<string, unknown>;
}
function own(value: Record<string, unknown>, name: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !("value" in descriptor)) return fail(path, `missing native ${name}`);
  return descriptor.value;
}
function bigint(value: unknown, path: string): bigint {
  if (typeof value !== "bigint") return fail(path, "expected exact bigint storage");
  return value;
}
function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fail(path, "expected bounded integer storage");
  return value;
}
const signedBits: Readonly<Record<string, number>> = {
  TINYINT: 8,
  SMALLINT: 16,
  INTEGER: 32,
  BIGINT: 64,
  HUGEINT: 128,
};
const unsignedBits: Readonly<Record<string, number>> = {
  UTINYINT: 8,
  USMALLINT: 16,
  UINTEGER: 32,
  UBIGINT: 64,
  UHUGEINT: 128,
};
export function assertDuckDBInteger(value: bigint, name: string, path = "input"): void {
  const bits = signedBits[name] ?? unsignedBits[name];
  if (!bits) {
    if (name !== "BIGNUM") fail(path, "unknown integer family");
    return;
  }
  const low = name.startsWith("U") ? 0n : -(1n << BigInt(bits - 1)),
    high = name.startsWith("U") ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n;
  if (value < low || value > high) fail(path, `${name} is outside its native integer range`);
}
export function formatDuckDBDecimal(coefficient: bigint, scale: number): string {
  const absolute = coefficient < 0n ? -coefficient : coefficient;
  const digits = absolute.toString().padStart(scale + 1, "0");
  return `${coefficient < 0n ? "-" : ""}${scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`}`;
}
export function parseDuckDBDecimal(value: unknown, precision: number, scale: number, path = "input"): bigint {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(value)) return fail(path, "expected exact decimal text");
  const [whole = "", fraction = ""] = value.replace(/^-/, "").split(".");
  if (fraction.length > scale && /[1-9]/u.test(fraction.slice(scale)))
    return fail(path, "decimal input would require rounding");
  const coefficient =
    BigInt(`${whole}${fraction.slice(0, scale).padEnd(scale, "0")}`) * (value.startsWith("-") ? -1n : 1n);
  if ((coefficient < 0n ? -coefficient : coefficient).toString().length > precision)
    return fail(path, "decimal input exceeds native precision");
  return coefficient;
}
const floor = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return a % b < 0n ? q - 1n : q;
};
export function duckDBCalendarDate(days: bigint): {
  readonly year: bigint;
  readonly month: number;
  readonly day: number;
} {
  const z = days + 719468n,
    era = floor(z, 146097n),
    dayOfEra = z - era * 146097n;
  const yearOfEra = (dayOfEra - dayOfEra / 1460n + dayOfEra / 36524n - dayOfEra / 146096n) / 365n;
  let year = yearOfEra + era * 400n;
  const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n),
    monthPrime = (5n * dayOfYear + 2n) / 153n;
  const day = Number(dayOfYear - (153n * monthPrime + 2n) / 5n + 1n),
    month = Number(monthPrime + (monthPrime < 10n ? 3n : -9n));
  if (month <= 2) year++;
  return { year, month, day };
}
export function duckDBDaysFromCalendar(year: bigint, month: number, day: number): bigint {
  const y = year - (month <= 2 ? 1n : 0n),
    era = floor(y, 400n),
    yoe = y - era * 400n,
    mp = BigInt(month + (month > 2 ? -3 : 9));
  const days = era * 146097n + yoe * 365n + yoe / 4n - yoe / 100n + (153n * mp + 2n) / 5n + BigInt(day) - 1n - 719468n;
  const actual = duckDBCalendarDate(days);
  if (actual.year !== year || actual.month !== month || actual.day !== day)
    throw new DuckDBValueError("input", "invalid calendar date");
  return days;
}
const pad = (value: number | bigint, digits = 2): string => value.toString().padStart(digits, "0");
function dateText(days: bigint): { readonly date: string; readonly bc: string } {
  const { year, month, day } = duckDBCalendarDate(days);
  return { date: `${pad(year <= 0n ? 1n - year : year, 4)}-${pad(month)}-${pad(day)}`, bc: year <= 0n ? " (BC)" : "" };
}
function clockText(ticks: bigint, precision: number): string {
  const unit = 10n ** BigInt(precision),
    seconds = ticks / unit,
    fraction = ticks % unit;
  return `${pad(seconds / 3600n)}:${pad((seconds / 60n) % 60n)}:${pad(seconds % 60n)}${precision ? `.${pad(fraction, precision)}` : ""}`;
}
export function formatDuckDBTimestamp(ticks: bigint, precision: number, timezone: boolean): string {
  if (ticks === (1n << 63n) - 1n) return "infinity";
  if (ticks === -((1n << 63n) - 1n)) return "-infinity";
  const dayUnit = 86400n * 10n ** BigInt(precision),
    days = floor(ticks, dayUnit),
    date = dateText(days);
  return `${date.date} ${clockText(ticks - days * dayUnit, precision)}${timezone ? "+00" : ""}${date.bc}`;
}
export function parseDuckDBTemporal(
  value: unknown,
  name: string,
  path = "input",
): { readonly ticks: bigint; readonly offset?: number } {
  if (typeof value !== "string") return fail(path, "expected canonical temporal text");
  const precision = ["TIME_NS", "TIMESTAMP_NS", "TIMESTAMPTZ_NS"].includes(name)
    ? 9
    : name === "TIMESTAMP_S"
      ? 0
      : name === "TIMESTAMP_MS"
        ? 3
        : 6;
  if ((value === "infinity" || value === "-infinity") && (name === "DATE" || name.startsWith("TIMESTAMP")))
    return { ticks: (value.startsWith("-") ? -1n : 1n) * (name === "DATE" ? (1n << 31n) - 1n : (1n << 63n) - 1n) };
  const timeOnly = name.startsWith("TIME") && !name.startsWith("TIMESTAMP");
  const match = timeOnly
    ? /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([+-]\d{2}(?::?\d{2})?(?::?\d{2})?)?$/u.exec(value)
    : /^(\d{4,})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([+-]\d{2}(?::?\d{2})?(?::?\d{2})?|Z)?)?( \(BC\))?$/u.exec(
        value,
      );
  if (!match) return fail(path, "invalid canonical temporal text");
  let days = 0n,
    hour = 0,
    minute = 0,
    second = 0,
    fraction = "",
    zone: string | undefined;
  if (timeOnly) {
    hour = Number(match[1]);
    minute = Number(match[2]);
    second = Number(match[3]);
    fraction = match[4] ?? "";
    zone = match[5];
  } else {
    const year = BigInt(match[1]!);
    if (year === 0n) return fail(path, "year zero is not canonical SQL text");
    days = duckDBDaysFromCalendar(match[9] ? 1n - year : year, Number(match[2]), Number(match[3]));
    hour = Number(match[4] ?? 0);
    minute = Number(match[5] ?? 0);
    second = Number(match[6] ?? 0);
    fraction = match[7] ?? "";
    zone = match[8];
    if (name !== "DATE" && match[4] === undefined) return fail(path, "timestamp requires a time");
  }
  if (
    hour > 24 ||
    minute > 59 ||
    second > 59 ||
    (hour === 24 && (minute !== 0 || second !== 0 || /[1-9]/u.test(fraction)))
  )
    return fail(path, "invalid time of day");
  if (name === "DATE") {
    if (match[4] !== undefined) return fail(path, "DATE cannot contain time");
    if (days <= -2147483647n || days >= 2147483647n) return fail(path, "DATE outside native range");
    return { ticks: days };
  }
  if (fraction.length > precision && /[1-9]/u.test(fraction.slice(precision)))
    return fail(path, "temporal input would lose precision");
  const aware = name === "TIMETZ" || name === "TIMESTAMPTZ" || name === "TIMESTAMPTZ_NS";
  if (aware && !zone) return fail(path, "timezone-aware temporal input requires an explicit offset");
  if (!aware && zone) return fail(path, "naive temporal input cannot contain an offset");
  let offset = 0;
  if (zone && zone !== "Z") {
    const parts = zone.slice(1).replaceAll(":", "");
    const h = Number(parts.slice(0, 2)),
      m = Number(parts.slice(2, 4) || 0),
      s = Number(parts.slice(4, 6) || 0);
    if (h > 15 || m > 59 || s > 59) return fail(path, "invalid timezone offset");
    offset = (zone.startsWith("-") ? -1 : 1) * (h * 3600 + m * 60 + s);
  }
  const unit = 10n ** BigInt(precision),
    daytime =
      BigInt(hour * 3600 + minute * 60 + second) * unit +
      BigInt(fraction.slice(0, precision).padEnd(precision, "0") || "0"),
    ticks = timeOnly ? daytime : days * 86400n * unit + daytime - BigInt(offset) * unit;
  if (!timeOnly && (ticks <= -((1n << 63n) - 1n) || ticks >= (1n << 63n) - 1n))
    return fail(path, "timestamp outside native range");
  return { ticks, ...(name === "TIMETZ" ? { offset } : {}) };
}
interface Budget {
  remaining: number;
}
function consume(budget: Budget, path: string): void {
  if (--budget.remaining < 0) fail(path, "native value node limit");
}
/** Recursively detach native SDK wrappers without the SDK's lossy JS convenience converter. */
export function decodeDuckDBValue(
  value: unknown,
  type: DuckDBType,
  policy: DuckDBTypePolicy = defaultDuckDBTypePolicy,
  path = "result",
  budget: Budget = { remaining: 1000000 },
): unknown {
  consume(budget, path);
  if (value === null) return null;
  if (!isKnownDuckDBType(type)) return fail(path, `unsupported native type ${formatDuckDBType(type)}`);
  const recurse = (item: unknown, child: DuckDBType, key: string): unknown =>
    decodeDuckDBValue(item, child, policy, `${path}${key}`, budget);
  switch (type.kind) {
    case "list":
    case "array": {
      const items = Array.isArray(value) ? value : own(object(value, path), "items", path);
      if (!Array.isArray(items) || (type.kind === "array" && items.length !== type.length))
        return fail(path, "native collection length mismatch");
      return items.map((item, i) => recurse(item, type.element, `[${i}]`));
    }
    case "tuple": {
      const items = Array.isArray(value) ? value : own(object(value, path), "items", path);
      if (!Array.isArray(items) || items.length !== type.elements.length)
        return fail(path, "native tuple length mismatch");
      return items.map((item, i) => recurse(item, type.elements[i]!, `[${i}]`));
    }
    case "struct": {
      const entries = object(own(object(value, path), "entries", path), path);
      const keys = Object.keys(entries);
      if (keys.length !== type.fields.length || type.fields.some((f) => !Object.hasOwn(entries, f.name)))
        return fail(path, "native struct shape mismatch");
      return Object.fromEntries(
        type.fields.map((f) => [f.name, recurse(own(entries, f.name, path), f.type, `.${f.name}`)]),
      );
    }
    case "map": {
      const entries = own(object(value, path), "entries", path);
      if (!Array.isArray(entries)) return fail(path, "expected native map entries");
      return entries.map((entry, i) => {
        const item = object(entry, path),
          key = own(item, "key", path);
        if (key === null) return fail(path, "native map key is NULL");
        return [
          recurse(key, type.key, `[${i}][0]`),
          recurse(own(item, "value", path), type.value, `[${i}][1]`),
        ] as const;
      });
    }
    case "union": {
      const item = object(value, path),
        tag = own(item, "tag", path);
      if (typeof tag !== "string") return fail(path, "invalid union tag");
      const field = type.fields.find((f) => duckDBAsciiFold(f.name) === duckDBAsciiFold(tag));
      if (!field) return fail(path, "unknown union tag");
      return { tag: field.name, value: recurse(own(item, "value", path), field.type, ".value") };
    }
    case "enum":
      if (typeof value !== "string" || !type.values.includes(value)) return fail(path, "invalid enum value");
      return value;
    case "scalar": {
      const name = type.name;
      if (name in signedBits || name in unsignedBits || name === "BIGNUM") {
        if (["TINYINT", "SMALLINT", "INTEGER", "UTINYINT", "USMALLINT", "UINTEGER"].includes(name)) {
          const result = integer(value, path);
          assertDuckDBInteger(BigInt(result), name, path);
          return result;
        }
        const result = bigint(value, path);
        assertDuckDBInteger(result, name, path);
        if (policy.bigint === "bigint") return result;
        if (policy.bigint === "string") return String(result);
        const resultNumber = Number(result);
        if (!Number.isSafeInteger(resultNumber)) return fail(path, "integer would lose precision");
        return resultNumber;
      }
      if (name === "DECIMAL") {
        const item = object(value, path);
        const scale = integer(own(item, "scale", path), path),
          width = integer(own(item, "width", path), path);
        if (scale !== type.scale || width !== type.precision) return fail(path, "decimal native target mismatch");
        return formatDuckDBDecimal(bigint(own(item, "value", path), path), scale);
      }
      if (name === "FLOAT" || name === "DOUBLE") {
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value))
        )
          return fail(path, "expected finite safely represented number");
        return value;
      }
      if (name === "BOOLEAN") {
        if (typeof value !== "boolean") return fail(path, "expected boolean");
        return value;
      }
      if (name === "VARCHAR" || name === "JSON") {
        if (typeof value !== "string") return fail(path, "expected string storage");
        return name === "JSON" && policy.json !== "string" ? JSON.parse(value) : value;
      }
      if (name === "BLOB") {
        const bytes = value instanceof Uint8Array ? value : own(object(value, path), "bytes", path);
        if (!(bytes instanceof Uint8Array)) return fail(path, "expected native blob");
        return Uint8Array.from(bytes);
      }
      if (name === "INTERVAL") {
        const item = object(value, path);
        return {
          months: integer(own(item, "months", path), path),
          days: integer(own(item, "days", path), path),
          micros: bigint(own(item, "micros", path), path),
        };
      }
      if (name === "UUID" || name === "BIT") {
        const item = object(value, path);
        if (typeof item.toString !== "function") return fail(path, "missing native string codec");
        const result = String(value);
        if (
          name === "UUID"
            ? !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(result)
            : !/^[01]*$/u.test(result)
        )
          return fail(path, "invalid native string codec result");
        return result;
      }
      if (name === "DATE") {
        const days = integer(own(object(value, path), "days", path), path);
        if (Math.abs(days) === 2147483647) return days < 0 ? "-infinity" : "infinity";
        const text = dateText(BigInt(days));
        return text.date + text.bc;
      }
      if (name === "TIME" || name === "TIME_NS" || name === "TIMETZ") {
        const item = object(value, path),
          precision = name === "TIME_NS" ? 9 : 6,
          ticks = bigint(own(item, name === "TIME_NS" ? "nanos" : "micros", path), path);
        if (ticks < 0n || ticks > 86400n * 10n ** BigInt(precision)) return fail(path, "invalid native time");
        let offset = "";
        if (name === "TIMETZ") {
          const seconds = integer(own(item, "offset", path), path),
            absolute = Math.abs(seconds);
          if (absolute > 57599) return fail(path, "invalid native timezone offset");
          offset = `${seconds < 0 ? "-" : "+"}${pad(Math.floor(absolute / 3600))}:${pad(Math.floor(absolute / 60) % 60)}${absolute % 60 ? `:${pad(absolute % 60)}` : ""}`;
        }
        return clockText(ticks, precision) + offset;
      }
      if (name.startsWith("TIMESTAMP")) {
        const precision =
          name === "TIMESTAMP_S"
            ? 0
            : name === "TIMESTAMP_MS"
              ? 3
              : name === "TIMESTAMP_NS" || name === "TIMESTAMPTZ_NS"
                ? 9
                : 6;
        const ticks = bigint(
          own(
            object(value, path),
            precision === 0 ? "seconds" : precision === 3 ? "millis" : precision === 9 ? "nanos" : "micros",
            path,
          ),
          path,
        );
        return formatDuckDBTimestamp(ticks, precision, name === "TIMESTAMPTZ" || name === "TIMESTAMPTZ_NS");
      }
      return fail(path, "unsupported native scalar storage");
    }
  }
}
/** A driver-neutral, already checked native input. Native SDK wrappers are created only by its adapter. */
export function encodeDuckDBValue(
  value: unknown,
  type: DuckDBType,
  policy: DuckDBTypePolicy = defaultDuckDBTypePolicy,
  path = "input",
  budget: Budget = { remaining: 1000000 },
): unknown {
  consume(budget, path);
  if (value === null) return null;
  if (!isKnownDuckDBType(type)) return fail(path, `unsupported native target ${formatDuckDBType(type)}`);
  const next = (item: unknown, child: DuckDBType, key: string) =>
    encodeDuckDBValue(item, child, policy, `${path}${key}`, budget);
  switch (type.kind) {
    case "list":
    case "array":
      if (!Array.isArray(value) || (type.kind === "array" && value.length !== type.length))
        return fail(path, "native array length mismatch");
      return value.map((item, i) => next(item, type.element, `[${i}]`));
    case "tuple":
      if (!Array.isArray(value) || value.length !== type.elements.length)
        return fail(path, "native tuple length mismatch");
      return value.map((item, i) => next(item, type.elements[i]!, `[${i}]`));
    case "struct": {
      const item = object(value, path);
      if (Object.keys(item).length !== type.fields.length) return fail(path, "struct shape mismatch");
      return Object.fromEntries(
        type.fields.map((field) => [field.name, next(own(item, field.name, path), field.type, `.${field.name}`)]),
      );
    }
    case "map": {
      if (!Array.isArray(value)) return fail(path, "expected ordered map entries");
      const seen = new Set<string>();
      return value.map((entry, i) => {
        if (!Array.isArray(entry) || entry.length !== 2 || entry[0] === null)
          return fail(path, "invalid map key/value entry");
        const key = next(entry[0], type.key, `[${i}][0]`),
          fingerprint = duckDBMapKeyIdentity(key);
        if (seen.has(fingerprint)) return fail(path, "map keys must be structurally unique");
        seen.add(fingerprint);
        return [key, next(entry[1], type.value, `[${i}][1]`)] as const;
      });
    }
    case "union": {
      const item = object(value, path),
        tag = own(item, "tag", path);
      if (typeof tag !== "string") return fail(path, "invalid union tag");
      const field = type.fields.find((field) => duckDBAsciiFold(field.name) === duckDBAsciiFold(tag));
      if (!field) return fail(path, "unknown union member");
      return { tag: field.name, value: next(own(item, "value", path), field.type, ".value") };
    }
    case "enum":
      if (typeof value !== "string" || !type.values.includes(value)) return fail(path, "unknown enum member");
      return value;
    case "scalar": {
      const name = type.name;
      if (name in signedBits || name in unsignedBits || name === "BIGNUM") {
        let exact: bigint;
        if (smallInteger(name)) {
          exact = BigInt(integer(value, path));
        } else if (policy.bigint === "string") {
          if (typeof value !== "string" || !/^-?\d+$/u.test(value)) return fail(path, "expected exact integer text");
          exact = BigInt(value);
        } else if (policy.bigint === "number") {
          exact = BigInt(integer(value, path));
        } else exact = bigint(value, path);
        assertDuckDBInteger(exact, name, path);
        return smallInteger(name) ? Number(exact) : exact;
      }
      if (name === "DECIMAL")
        return {
          value: parseDuckDBDecimal(value, type.precision!, type.scale!, path),
          width: type.precision!,
          scale: type.scale!,
        };
      if (name === "VARCHAR" || name === "JSON") {
        if (typeof value !== "string") return fail(path, "expected text bind value");
        if (name === "JSON") JSON.parse(value);
        return value;
      }
      if (name === "UUID") {
        if (
          typeof value !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
        )
          return fail(path, "invalid UUID input");
        return BigInt(`0x${value.replaceAll("-", "")}`);
      }
      if (name === "BIT") {
        if (typeof value !== "string" || !/^[01]*$/u.test(value)) return fail(path, "invalid BIT input");
        return value;
      }
      if (name === "BLOB") {
        if (!(value instanceof Uint8Array)) return fail(path, "expected byte input");
        return Uint8Array.from(value);
      }
      if (name === "BOOLEAN") {
        if (typeof value !== "boolean") return fail(path, "expected boolean input");
        return value;
      }
      if (name === "FLOAT" || name === "DOUBLE") {
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value))
        )
          return fail(path, "expected finite safely represented number");
        if (name === "FLOAT" && !Number.isFinite(Math.fround(value)))
          return fail(path, "FLOAT input exceeds native range");
        return value;
      }
      if (name === "INTERVAL") {
        const item = object(value, path),
          months = integer(own(item, "months", path), path),
          days = integer(own(item, "days", path), path),
          micros = bigint(own(item, "micros", path), path);
        assertDuckDBInteger(BigInt(months), "INTEGER", path);
        assertDuckDBInteger(BigInt(days), "INTEGER", path);
        assertDuckDBInteger(micros, "BIGINT", path);
        return { months, days, micros };
      }
      if (name === "DATE" || name.startsWith("TIME")) return parseDuckDBTemporal(value, name, path);
      return fail(path, "non-NULL input cannot satisfy the native NULL type");
    }
  }
}
function smallInteger(name: string): boolean {
  return ["TINYINT", "SMALLINT", "INTEGER", "UTINYINT", "USMALLINT", "UINTEGER"].includes(name);
}
/** Native SQL key equality for the supported finite, normalized key families, including nested NULL. */
export function duckDBMapKeyIdentity(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return `i:${value}`;
  if (typeof value === "number") return `n:${Object.is(value, -0) ? 0 : value}`;
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `b:${value}`;
  if (value instanceof Uint8Array) return `bytes:${Array.from(value).join(",")}`;
  if (Array.isArray(value)) return `[${value.map(duckDBMapKeyIdentity).join(";")}]`;
  const item = object(value, "map key");
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${duckDBMapKeyIdentity(own(item, key, "map key"))}`)
    .join(";")}}`;
}
