import { requireSqlServerNativeType } from "./native-types.js";
import type { OdbcColumn } from "./odbc-protocol.js";

/** Read only after this physical connection's database and session have been attested. */
export const sqlServerOdbcAliasQuery = `SELECT CONVERT(nvarchar(128),s.name) AS alias_schema,CONVERT(nvarchar(128),t.name) AS alias_name,CONVERT(nvarchar(128),b.name) AS base_name,t.max_length,t.precision,t.scale FROM sys.types t JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.types b ON b.user_type_id=t.system_type_id WHERE t.is_user_defined=1 AND t.is_assembly_type=0 AND t.is_table_type=0 ORDER BY s.name,t.name`;
interface Alias {
  readonly databaseType: string;
  readonly baseName: string;
  readonly precision: number;
  readonly scale: number;
}
export type OdbcAliasRegistry = ReadonlyMap<string, Alias | null>;
const fixedNumeric: Readonly<Record<string, readonly [number, number]>> = {
  bigint: [19, 0],
  int: [10, 0],
  smallint: [5, 0],
  tinyint: [3, 0],
  bit: [1, 0],
  money: [19, 4],
  smallmoney: [10, 4],
};
const codes: Readonly<Record<string, readonly number[]>> = {
  bigint: [-5],
  int: [4],
  smallint: [5],
  tinyint: [-6],
  bit: [-7],
  decimal: [2, 3],
  money: [3],
  smallmoney: [3],
  real: [7],
  float: [6, 8],
  char: [1],
  varchar: [12],
  text: [-1],
  nchar: [-8],
  nvarchar: [-9],
  ntext: [-10],
  binary: [-2],
  varbinary: [-3],
  image: [-4],
  date: [91],
  time: [92, -154],
  datetime: [93],
  smalldatetime: [93],
  datetime2: [93],
  datetimeoffset: [-155],
  uniqueidentifier: [-11],
  xml: [-152],
  rowversion: [-2],
};
function integer(value: unknown): number {
  const number =
    typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number)) throw new TypeError("Invalid SQL Server native alias dimensions");
  return number;
}
export function sqlServerOdbcAliasRegistry(rows: readonly Record<string, unknown>[]): OdbcAliasRegistry {
  if (rows.length > 10000) throw new RangeError("SQL Server native alias registry exceeds its bound");
  const result = new Map<string, Alias | null>();
  for (const row of rows) {
    if (
      typeof row.alias_schema !== "string" ||
      !row.alias_schema ||
      row.alias_schema.length > 128 ||
      typeof row.alias_name !== "string" ||
      !row.alias_name ||
      row.alias_name.length > 128 ||
      typeof row.base_name !== "string"
    )
      throw new TypeError("Invalid SQL Server native alias identity");
    const base = requireSqlServerNativeType(row.base_name),
      length = integer(row.max_length),
      precision = integer(row.precision),
      scale = integer(row.scale);
    const fixed = fixedNumeric[base.name];
    if (fixed && (precision !== fixed[0] || scale !== fixed[1]))
      throw new TypeError("Invalid SQL Server fixed numeric alias dimensions");
    let declaration = base.text;
    if (["char", "varchar", "nchar", "nvarchar", "binary", "varbinary"].includes(base.name))
      declaration = `${base.name}(${length === -1 ? "max" : base.name.startsWith("n") ? length / 2 : length})`;
    else if (base.name === "decimal") declaration = `decimal(${precision},${scale})`;
    else if (["time", "datetime2", "datetimeoffset"].includes(base.name)) declaration = `${base.name}(${scale})`;
    const target = requireSqlServerNativeType(declaration),
      key = row.alias_name.toLowerCase();
    result.set(
      key,
      result.has(key) || !codes[target.name]
        ? null
        : { databaseType: target.text, baseName: target.name, precision, scale },
    );
  }
  return result;
}
export function sqlServerOdbcAlias(column: OdbcColumn, registry: OdbcAliasRegistry): Alias | undefined {
  const key = column.typeName.toLowerCase();
  if (!registry.has(key)) return undefined;
  const alias = registry.get(key);
  if (!alias || !codes[alias.baseName]!.includes(column.type))
    throw new TypeError("SQL Server alias metadata is ambiguous or disagrees with the native ODBC family");
  if (fixedNumeric[alias.baseName] && (column.size !== alias.precision || column.scale !== alias.scale))
    throw new TypeError("SQL Server alias dimensions disagree with verified native catalog metadata");
  return alias;
}

/** The wire code is independent evidence even when a hidden alias resembles a builtin name. */
export function assertSqlServerOdbcFamily(column: OdbcColumn, name: string): void {
  if (!codes[name]?.includes(column.type))
    throw new TypeError("SQL Server native type name disagrees with its independently reported ODBC family");
  const dimensions = fixedNumeric[name];
  if (dimensions && (column.size !== dimensions[0] || column.scale !== dimensions[1]))
    throw new TypeError("SQL Server fixed numeric metadata disagrees with its native dimensions");
  if (name === "rowversion" && (column.size !== 8 || column.scale !== 0))
    throw new TypeError("SQL Server rowversion metadata disagrees with its native dimensions");
}
