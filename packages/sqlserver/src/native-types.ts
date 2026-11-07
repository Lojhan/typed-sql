import { fixedTypeAliases, typeAliases, typeRules } from "./catalog/generated/types.js";
import { validateSqlServerCollationName } from "./collation.js";

export { integerBounds as SQLSERVER_INTEGER_BOUNDS } from "./catalog/generated/types.js";
export type SqlServerTypeContext = "declaration" | "cast";
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
export interface SqlServerNativeTypeRule {
  readonly name: string;
  readonly form: "plain" | "sized" | "decimal" | "temporal" | "float";
  readonly mapping:
    | "number"
    | "string"
    | "boolean"
    | "Uint8Array"
    | "bigint"
    | "decimal"
    | "temporal"
    | "json"
    | "unknown";
  readonly maximumLength?: number;
  readonly defaultLengths?: Readonly<Record<SqlServerTypeContext, number>>;
  readonly maximumPrecision: number;
  readonly maximumScale: number;
  readonly allowsMax?: boolean;
  readonly signed?: boolean;
  readonly byteWidth?: number;
  readonly nativeName?: string;
}
export function parseSqlServerNativeType(
  source: string,
  context: SqlServerTypeContext = "declaration",
): SqlServerNativeType | undefined {
  if (source.length > 512) return undefined;
  const collated = /^(.*?)\s+COLLATE\s+([A-Za-z][A-Za-z0-9_]{0,127})$/iu.exec(source.trim());
  if (collated) {
    const base = parseSqlServerNativeType(collated[1]!, context);
    if (!base || base.collation || !["varchar", "char", "nvarchar", "nchar", "text", "ntext"].includes(base.name))
      return undefined;
    const collation = validateSqlServerCollationName(collated[2]!);
    return Object.freeze({ ...base, baseText: base.text, collation, text: `${base.text} COLLATE ${collation}` });
  }
  const match = /^\s*([a-z][a-z0-9_ ]*)(?:\(\s*(max|\d+)\s*(?:,\s*(\d+)\s*)?\))?\s*$/iu.exec(source);
  if (!match) return undefined;
  const raw = match[1]!.trim().toLowerCase().replace(/ +/gu, " ");
  const name = typeAliases[raw] ?? raw;
  const rule = typeRules[name];
  const first = match[2]?.toLowerCase();
  const second = match[3];
  const integer = first === undefined || first === "max" ? undefined : Number(first);
  if (integer !== undefined && !Number.isSafeInteger(integer)) return undefined;
  const fixed = fixedTypeAliases[name];
  if (fixed) return first === undefined ? Object.freeze({ ...fixed }) : undefined;
  if (!rule) return undefined;
  if (rule.form === "plain") return first === undefined ? Object.freeze({ name, text: name }) : undefined;
  if (rule.form === "sized") {
    if (second !== undefined) return undefined;
    const length = first === undefined ? rule.defaultLengths?.[context] : first === "max" ? "max" : integer!;
    if (length === undefined) return undefined;
    if (length === "max" ? !rule.allowsMax : length < 1 || length > (rule.maximumLength ?? 0)) return undefined;
    return Object.freeze({ name, text: `${name}(${length})`, length });
  }
  if (rule.form === "decimal") {
    const precision = integer ?? 18,
      scale = second === undefined ? 0 : Number(second);
    if (first === "max" || precision < 1 || precision > rule.maximumPrecision || scale < 0 || scale > precision)
      return undefined;
    return Object.freeze({ name, text: `decimal(${precision},${scale})`, precision, scale });
  }
  if (rule.form === "temporal") {
    const scale = integer ?? rule.maximumScale;
    if (first === "max" || second !== undefined || scale < 0 || scale > rule.maximumScale) return undefined;
    return Object.freeze({ name, text: `${name}(${scale})`, scale });
  }
  if (rule.form === "float") {
    const precision = integer ?? rule.maximumPrecision;
    if (first === "max" || second !== undefined || precision < 1 || precision > rule.maximumPrecision) return undefined;
    return precision <= typeRules.real!.maximumPrecision
      ? Object.freeze({ name: "real", text: "real" })
      : Object.freeze({ name, text: `float(${rule.maximumPrecision})`, precision: rule.maximumPrecision });
  }
  return undefined;
}
export function requireSqlServerNativeType(
  source: string,
  context: SqlServerTypeContext = "declaration",
): SqlServerNativeType {
  const type = parseSqlServerNativeType(source, context);
  if (!type) throw new TypeError(`Unsupported or invalid SQL Server native type: ${source.slice(0, 256)}`);
  return type;
}
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
