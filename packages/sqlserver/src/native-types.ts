import { validateSqlServerCollationName } from "./collation.js";
/** Canonical allowlisted SQL Server system types. Unknown user/CLR types remain opaque. */
export interface SqlServerNativeType {
  readonly name: string;
  readonly text: string;
  readonly baseText?: string;
  readonly collation?: string;
  readonly length?: number | "max";
  readonly precision?: number;
  readonly scale?: number;
}
const plain = new Set([
  "bigint",
  "int",
  "smallint",
  "tinyint",
  "bit",
  "money",
  "smallmoney",
  "real",
  "date",
  "datetime",
  "smalldatetime",
  "uniqueidentifier",
  "xml",
  "text",
  "ntext",
  "image",
  "sql_variant",
  "json",
  "rowversion",
]);
const sized = new Set(["char", "varchar", "nchar", "nvarchar", "binary", "varbinary"]);
const aliases: Readonly<Record<string, string>> = {
  integer: "int",
  dec: "decimal",
  numeric: "decimal",
  timestamp: "rowversion",
  "double precision": "float",
  "character varying": "varchar",
  character: "char",
};
export function parseSqlServerNativeType(source: string): SqlServerNativeType | undefined {
  if (source.length > 512) return undefined;
  const collated = /^(.*?)\s+COLLATE\s+([A-Za-z][A-Za-z0-9_]{0,127})$/iu.exec(source.trim());
  if (collated) {
    const base = parseSqlServerNativeType(collated[1]!);
    if (!base || base.collation || !["varchar", "char", "nvarchar", "nchar", "text", "ntext"].includes(base.name))
      return undefined;
    const collation = validateSqlServerCollationName(collated[2]!);
    return Object.freeze({ ...base, baseText: base.text, collation, text: `${base.text} COLLATE ${collation}` });
  }
  const match = /^\s*([a-z][a-z0-9_ ]*)(?:\(\s*(max|\d+)\s*(?:,\s*(\d+)\s*)?\))?\s*$/iu.exec(source);
  if (!match) return undefined;
  const raw = match[1]!.trim().toLowerCase().replace(/ +/gu, " ");
  const name = aliases[raw] ?? raw;
  const first = match[2]?.toLowerCase();
  const second = match[3];
  const integer = first === undefined || first === "max" ? undefined : Number(first);
  if (integer !== undefined && !Number.isSafeInteger(integer)) return undefined;
  if (plain.has(name)) return first === undefined ? Object.freeze({ name, text: name }) : undefined;
  if (sized.has(name)) {
    if (second !== undefined) return undefined;
    const length = first === undefined ? 1 : first === "max" ? "max" : integer!;
    if (
      length === "max"
        ? !["varchar", "nvarchar", "varbinary"].includes(name)
        : length < 1 || length > (name.startsWith("n") ? 4000 : 8000)
    )
      return undefined;
    return Object.freeze({ name, text: `${name}(${length})`, length });
  }
  if (name === "decimal") {
    const precision = integer ?? 18,
      scale = second === undefined ? 0 : Number(second);
    if (first === "max" || precision < 1 || precision > 38 || scale < 0 || scale > precision) return undefined;
    return Object.freeze({ name, text: `decimal(${precision},${scale})`, precision, scale });
  }
  if (["time", "datetime2", "datetimeoffset"].includes(name)) {
    const scale = integer ?? 7;
    if (first === "max" || second !== undefined || scale < 0 || scale > 7) return undefined;
    return Object.freeze({ name, text: `${name}(${scale})`, scale });
  }
  if (name === "float") {
    const precision = integer ?? 53;
    if (first === "max" || second !== undefined || precision < 1 || precision > 53) return undefined;
    return Object.freeze({ name, text: `float(${precision})`, precision });
  }
  return undefined;
}
export function requireSqlServerNativeType(source: string): SqlServerNativeType {
  const type = parseSqlServerNativeType(source);
  if (!type) throw new TypeError(`Unsupported or invalid SQL Server native type: ${source.slice(0, 256)}`);
  return type;
}
export const SQLSERVER_INTEGER_BOUNDS: Readonly<Record<string, readonly [bigint, bigint]>> = Object.freeze({
  tinyint: Object.freeze([0n, 255n] as const),
  smallint: Object.freeze([-32768n, 32767n] as const),
  int: Object.freeze([-2147483648n, 2147483647n] as const),
  bigint: Object.freeze([-(1n << 63n), (1n << 63n) - 1n] as const),
});
export function validateSqlServerDecimal(value: string, type: SqlServerNativeType): string {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match || value.length > 96) throw new TypeError("SQL Server exact decimal requires finite decimal text");
  const scale = type.scale ?? (type.name === "money" || type.name === "smallmoney" ? 4 : 0);
  const precision = type.precision ?? (type.name === "money" ? 19 : type.name === "smallmoney" ? 10 : 18);
  const integral = match[2]!.replace(/^0+(?=\d)/u, "");
  const fraction = match[3] ?? "";
  if (fraction.length > scale && /[1-9]/u.test(fraction.slice(scale)))
    throw new RangeError("SQL Server decimal input requires rounding");
  if ((integral === "0" ? 0 : integral.length) > precision - scale)
    throw new RangeError("SQL Server decimal input exceeds precision");
  const digits = integral + fraction.slice(0, scale).padEnd(scale, "0");
  const coefficient = BigInt(`${match[1] === "-" ? "-" : ""}${digits}`);
  if (type.name === "money" && (coefficient < -(1n << 63n) || coefficient > (1n << 63n) - 1n))
    throw new RangeError("SQL Server money input out of range");
  if (type.name === "smallmoney" && (coefficient < -2147483648n || coefficient > 2147483647n))
    throw new RangeError("SQL Server smallmoney input out of range");
  const sign = coefficient < 0n ? "-" : "";
  return `${sign}${integral}${scale ? `.${fraction.slice(0, scale).padEnd(scale, "0")}` : ""}`;
}
