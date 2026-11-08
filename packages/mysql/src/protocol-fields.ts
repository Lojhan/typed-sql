export interface MySqlProtocolField {
  readonly name?: string;
  readonly orgName?: string;
  readonly table?: string;
  readonly orgTable?: string;
  readonly db?: string;
  readonly schema?: string;
  readonly columnType?: number;
  readonly type?: number;
  readonly columnLength?: number;
  readonly length?: number;
  readonly flags?: number | readonly string[];
  readonly decimals?: number;
  readonly characterSet?: number;
}

const mysqlTypeNames = new Map<number, string>([
  [0, "decimal"],
  [1, "tinyint"],
  [2, "smallint"],
  [3, "int"],
  [4, "float"],
  [5, "double"],
  [6, "null"],
  [7, "timestamp"],
  [8, "bigint"],
  [9, "mediumint"],
  [10, "date"],
  [11, "time"],
  [12, "datetime"],
  [13, "year"],
  [15, "varchar"],
  [16, "bit"],
  [242, "vector"],
  [245, "json"],
  [246, "decimal"],
  [247, "enum"],
  [248, "set"],
  [249, "tinyblob"],
  [250, "mediumblob"],
  [251, "longblob"],
  [252, "blob"],
  [253, "varchar"],
  [254, "char"],
  [255, "geometry"],
]);

export function mySqlProtocolFlags(field: MySqlProtocolField): number | undefined {
  const flags = field.flags;
  return typeof flags === "number" && Number.isInteger(flags) && flags >= 0 && flags <= 65535 ? flags : undefined;
}

/** Protocol dimensions describe each slot independently; result casts are not input declarations. */
export function mySqlProtocolType(field: MySqlProtocolField): string | undefined {
  const code = field.columnType ?? field.type;
  if (code === undefined) return undefined;
  const base = mysqlTypeNames.get(code);
  if (!base) return undefined;
  const flags = mySqlProtocolFlags(field);
  const length = field.columnLength ?? field.length;
  if ([0, 246].includes(code)) {
    const scale = field.decimals;
    if (flags === undefined || !Number.isSafeInteger(length) || !Number.isSafeInteger(scale)) return undefined;
    const unsigned = (flags & 32) !== 0;
    const precision = length! - (unsigned ? 0 : 1) - (scale! > 0 ? 1 : 0);
    if (precision < 1 || precision > 65 || scale! < 0 || scale! > 30 || scale! > precision) return undefined;
    return `decimal(${precision},${scale})${unsigned ? " unsigned" : ""}`;
  }
  if ([1, 2, 3, 8, 9].includes(code)) {
    if (flags === undefined) return undefined;
    return `${code === 1 && length === 1 ? "tinyint(1)" : base}${(flags & 32) !== 0 ? " unsigned" : ""}`;
  }
  if ([15, 253, 254, 249, 250, 251, 252].includes(code)) {
    if (!Number.isSafeInteger(field.characterSet) || field.characterSet! <= 0 || field.characterSet! > 65535)
      return undefined;
    const binary = field.characterSet === 63;
    if ([15, 253].includes(code)) return binary ? "varbinary" : "varchar";
    if (code === 254) return binary ? "binary" : "char";
    return binary ? base : base.replace("blob", "text");
  }
  return base;
}
