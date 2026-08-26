import type { MySqlTypePolicy } from "./type-policy.js";

export interface MySqlFieldLike {
  readonly name: string;
  readonly columnType: number;
  readonly columnLength?: number;
}

export type MySqlRuntimeTypePolicy = Pick<MySqlTypePolicy, "bigint" | "decimal" | "date" | "json" | "tinyint1">;

type ValueDecoder = (value: unknown) => unknown;

export interface MySqlColumnDecoder {
  readonly name: string;
  readonly decode: ValueDecoder;
}

const mysqlTypes = { tiny: 1, longlong: 8, date: 10, datetime: 12, timestamp: 7, json: 245, decimal: 246 } as const;

export function encodeMySqlValue(value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(encodeMySqlValue) : value;
}

function finite(value: string, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result))
    throw new RangeError(`${label} value ${value} cannot be represented as a finite number`);
  return result;
}

function nullable(decoder: ValueDecoder): ValueDecoder {
  return (value) => (value === null || value === undefined ? value : decoder(value));
}

function compileValueDecoder(
  field: MySqlFieldLike,
  typePolicy: MySqlRuntimeTypePolicy,
  decimal?: (value: string) => unknown,
): ValueDecoder | undefined {
  if (field.columnType === mysqlTypes.longlong) {
    if (typePolicy.bigint === "bigint") return nullable((value) => BigInt(String(value)));
    if (typePolicy.bigint === "number")
      return nullable((value) => {
        const result = finite(String(value), "bigint");
        if (!Number.isSafeInteger(result))
          throw new RangeError(`bigint value ${value} exceeds JavaScript's safe integer range`);
        return result;
      });
    return nullable((value) => String(value));
  }
  if (field.columnType === mysqlTypes.decimal) {
    if (typePolicy.decimal === "number") return nullable((value) => finite(String(value), "decimal"));
    if (typePolicy.decimal === "Decimal") {
      if (decimal === undefined) throw new TypeError("decimal=Decimal requires a decimal(value) codec");
      return nullable((value) => decimal(String(value)));
    }
    return nullable((value) => String(value));
  }
  if (
    field.columnType === mysqlTypes.date ||
    field.columnType === mysqlTypes.datetime ||
    field.columnType === mysqlTypes.timestamp
  ) {
    return typePolicy.date === "string"
      ? nullable((value) => String(value))
      : nullable((value) => (value instanceof Date ? value : new Date(String(value))));
  }
  if (field.columnType === mysqlTypes.json && typePolicy.json === "string")
    return nullable((value) => (typeof value === "string" ? value : JSON.stringify(value)));
  if (field.columnType === mysqlTypes.tiny && field.columnLength === 1 && typePolicy.tinyint1 === "boolean")
    return nullable((value) => value === true || value === 1 || value === "1");
  return undefined;
}

/** Compiles immutable field metadata into a decoder plan shared by buffered and streamed rows. */
export function compileMySqlRowDecoders(
  fields: readonly MySqlFieldLike[],
  typePolicy: MySqlRuntimeTypePolicy,
  decimal?: (value: string) => unknown,
): readonly MySqlColumnDecoder[] {
  const decoders: MySqlColumnDecoder[] = [];
  const visited = new Set<string>();
  for (const field of fields) {
    // Preserve established behavior: the first metadata entry for a row property owns its decoding.
    if (visited.has(field.name)) continue;
    visited.add(field.name);
    const decode = compileValueDecoder(field, typePolicy, decimal);
    if (decode !== undefined) decoders.push({ name: field.name, decode });
  }
  return decoders;
}

export function decodeMySqlRows(
  rows: readonly Record<string, unknown>[],
  decoders: readonly MySqlColumnDecoder[],
): readonly Record<string, unknown>[] {
  if (decoders.length === 0) return rows;
  // Keep driver objects intact until a codec produces a different value for that specific row.
  let decodedRows: Record<string, unknown>[] | undefined;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const decodedRow = decodeMySqlRow(row, decoders);
    if (decodedRow === row) continue;
    decodedRows ??= rows.slice() as Record<string, unknown>[];
    decodedRows[rowIndex] = decodedRow;
  }
  return decodedRows ?? rows;
}

/** Decodes one streamed row without allocating an intermediate one-element array. */
export function decodeMySqlRow(
  row: Record<string, unknown>,
  decoders: readonly MySqlColumnDecoder[],
): Record<string, unknown> {
  let decodedRow: Record<string, unknown> | undefined;
  for (const column of decoders) {
    if (!Object.prototype.propertyIsEnumerable.call(row, column.name)) continue;
    const value = row[column.name];
    const decoded = column.decode(value);
    if (Object.is(decoded, value)) continue;
    decodedRow ??= { ...row };
    decodedRow[column.name] = decoded;
  }
  return decodedRow ?? row;
}
