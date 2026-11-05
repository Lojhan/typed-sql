/** SQL Server-owned built-in catalog. Dynamic/unknown routine overloads never inherit a guessed type. */
export type SqlServerBuiltinRule =
  | "count"
  | "countBig"
  | "sum"
  | "avg"
  | "same"
  | "nullableSame"
  | "coalesce"
  | "isnull"
  | "integer"
  | "bigint"
  | "float"
  | "real"
  | "string"
  | "nvarcharMax"
  | "varcharMax"
  | "date"
  | "datetime"
  | "datetime2"
  | "datetimeoffset"
  | "bit"
  | "uuid"
  | "bytes"
  | "dateadd"
  | "datepart"
  | "datename"
  | "datediff"
  | "datediffBig"
  | "jsonValue"
  | "jsonQuery"
  | "jsonModify"
  | "jsonObject"
  | "jsonArray"
  | "leastGreatest"
  | "iif"
  | "choose"
  | "grouping"
  | "abs"
  | "variant"
  | "identity"
  | "dateTrunc"
  | "dateBucket";
export interface SqlServerBuiltin {
  readonly name: string;
  readonly minimumArguments: number;
  readonly maximumArguments: number;
  readonly kind: "scalar" | "aggregate" | "window" | "table";
  readonly rule: SqlServerBuiltinRule;
  readonly nullable: boolean;
  readonly volatility: "immutable" | "stable" | "volatile";
  readonly since?: number;
  readonly compatibility?: number;
}
const entries: SqlServerBuiltin[] = [];
function add(
  names: string,
  rule: SqlServerBuiltinRule,
  minimumArguments: number,
  maximumArguments = minimumArguments,
  options: Partial<Pick<SqlServerBuiltin, "kind" | "nullable" | "volatility" | "since" | "compatibility">> = {},
): void {
  for (const name of names.split(" "))
    entries.push(
      Object.freeze({
        name,
        rule,
        minimumArguments,
        maximumArguments,
        kind: "scalar",
        nullable: true,
        volatility: "immutable",
        ...options,
      }),
    );
}
add("COUNT", "count", 1, 1, { kind: "aggregate", nullable: false });
add("COUNT_BIG", "countBig", 1, 1, { kind: "aggregate", nullable: false });
add("SUM", "sum", 1, 1, { kind: "aggregate" });
add("AVG", "avg", 1, 1, { kind: "aggregate" });
add("MIN MAX", "nullableSame", 1, 1, { kind: "aggregate" });
add("STDEV STDEVP VAR VARP", "float", 1, 1, { kind: "aggregate" });
add("STRING_AGG", "nvarcharMax", 2, 2, { kind: "aggregate", since: 14 });
add("CHECKSUM_AGG", "integer", 1, 1, { kind: "aggregate" });
add("GROUPING GROUPING_ID", "grouping", 1, 32, { nullable: false });
add("ROW_NUMBER RANK DENSE_RANK", "bigint", 0, 0, { kind: "window", nullable: false });
add("NTILE", "bigint", 1, 1, { kind: "window", nullable: false });
add("PERCENT_RANK CUME_DIST", "float", 0, 0, { kind: "window", nullable: false });
add("LAG LEAD", "nullableSame", 1, 3, { kind: "window" });
add("FIRST_VALUE LAST_VALUE", "nullableSame", 1, 1, { kind: "window" });
add("PERCENTILE_CONT PERCENTILE_DISC", "float", 1, 1, { kind: "window" });
add("COALESCE", "coalesce", 2, 256);
add("ISNULL", "isnull", 2);
add("NULLIF", "nullableSame", 2);
add("IIF", "iif", 3);
add("CHOOSE", "choose", 2, 256);
add("ABS", "abs", 1);
add("CEILING FLOOR SIGN", "same", 1);
add("ROUND", "same", 2, 3);
add("SQUARE SQRT EXP LOG10 COS SIN TAN COT ACOS ASIN ATAN DEGREES RADIANS", "float", 1);
add("LOG", "float", 1, 2);
add("ATN2", "float", 2);
add("POWER", "abs", 2);
add("PI", "float", 0, 0, { nullable: false });
add("RAND", "float", 0, 1, { nullable: false, volatility: "volatile" });
add("LEN DATALENGTH ASCII UNICODE", "integer", 1);
add("CHARINDEX", "integer", 2, 3);
add("PATINDEX DIFFERENCE", "integer", 2);
add("SOUNDEX", "string", 1);
add("CHAR NCHAR", "string", 1);
add("LEFT RIGHT REPLICATE STRING_ESCAPE", "string", 2);
add("SUBSTRING REPLACE TRANSLATE", "string", 3);
add("STUFF", "string", 4);
add("SPACE LOWER UPPER REVERSE", "string", 1);
add("LTRIM RTRIM TRIM QUOTENAME", "string", 1, 2);
add("FORMAT", "string", 2, 3);
add("STR", "string", 1, 3);
add("CONCAT CONCAT_WS", "nvarcharMax", 2, 256, { nullable: false });
add("ISDATE ISNUMERIC", "integer", 1, 1, { nullable: false });
add("ISJSON", "integer", 1, 2, { nullable: false });
add("JSON_PATH_EXISTS", "integer", 2, 2, { nullable: false, since: 16 });
add("GETDATE CURRENT_TIMESTAMP GETUTCDATE", "datetime", 0, 0, { nullable: false, volatility: "stable" });
add("SYSDATETIME SYSUTCDATETIME", "datetime2", 0, 0, { nullable: false, volatility: "stable" });
add("SYSDATETIMEOFFSET", "datetimeoffset", 0, 0, { nullable: false, volatility: "stable" });
add("DATEADD", "dateadd", 3);
add("DATEDIFF", "datediff", 3);
add("DATEDIFF_BIG", "datediffBig", 3);
add("DATEPART", "datepart", 2);
add("DATENAME", "datename", 2);
add("YEAR MONTH DAY", "integer", 1);
add("DATEFROMPARTS", "date", 3);
add("DATETIMEFROMPARTS", "datetime", 7);
add("DATETIME2FROMPARTS", "datetime2", 8);
add("DATETIMEOFFSETFROMPARTS", "datetimeoffset", 10);
add("EOMONTH", "date", 1, 2);
add("DATETRUNC", "dateTrunc", 2, 2, { since: 16 });
add("DATE_BUCKET", "dateBucket", 3, 4, { since: 16 });
add("SWITCHOFFSET TODATETIMEOFFSET", "datetimeoffset", 2);
add("NEWID NEWSEQUENTIALID", "uuid", 0, 0, { nullable: false, volatility: "volatile" });
add("SCOPE_IDENTITY", "identity", 0, 0, { volatility: "volatile" });
add("IDENT_CURRENT", "identity", 1, 1, { volatility: "volatile" });
add("CHECKSUM BINARY_CHECKSUM", "integer", 1, 256);
add("HASHBYTES", "bytes", 2);
add("COMPRESS DECOMPRESS", "bytes", 1);
add("OBJECT_ID", "integer", 1, 2, { volatility: "stable" });
add("SCHEMA_ID DB_ID", "integer", 0, 1, { volatility: "stable" });
add("COL_LENGTH OBJECTPROPERTY", "integer", 2, 2, { volatility: "stable" });
add("COLUMNPROPERTY", "integer", 3, 3, { volatility: "stable" });
add("OBJECT_NAME", "string", 1, 2, { volatility: "stable" });
add("SCHEMA_NAME DB_NAME USER_NAME SUSER_NAME SUSER_SNAME", "string", 0, 1, { volatility: "stable" });
add("COL_NAME", "string", 2, 2, { volatility: "stable" });
add("TYPE_NAME", "string", 1, 1, { volatility: "stable" });
add("CURRENT_USER SESSION_USER SYSTEM_USER USER HOST_NAME APP_NAME ORIGINAL_LOGIN", "string", 0, 0, {
  volatility: "stable",
});
add("SESSION_CONTEXT SERVERPROPERTY", "variant", 1, 1, { volatility: "stable" });
add("DATABASEPROPERTYEX SQL_VARIANT_PROPERTY OBJECTPROPERTYEX", "variant", 2, 2, { volatility: "stable" });
add("JSON_VALUE", "jsonValue", 2);
add("JSON_QUERY", "jsonQuery", 1, 2);
add("JSON_MODIFY", "jsonModify", 3);
add("JSON_OBJECT", "jsonObject", 0, 256, { since: 16, nullable: false });
add("JSON_ARRAY", "jsonArray", 0, 256, { since: 16, nullable: false });
add("GREATEST LEAST", "leastGreatest", 1, 254, { since: 16 });
add("JSON_ARRAYAGG", "jsonArray", 1, 1, { since: 17, kind: "aggregate" });
add("JSON_OBJECTAGG", "jsonObject", 2, 2, { since: 17, kind: "aggregate" });
add("REGEXP_COUNT REGEXP_INSTR", "integer", 2, 6, { since: 17, compatibility: 170 });
add("REGEXP_LIKE", "bit", 2, 3, { since: 17, compatibility: 170 });
add("REGEXP_REPLACE REGEXP_SUBSTR", "string", 2, 6, { since: 17, compatibility: 170 });
export const SQLSERVER_BUILTINS: Readonly<Record<string, SqlServerBuiltin>> = Object.freeze(
  Object.fromEntries(entries.map((entry) => [entry.name, entry])),
);
export const SQLSERVER_DATEPARTS: ReadonlySet<string> = new Set([
  "YEAR",
  "YY",
  "YYYY",
  "QUARTER",
  "QQ",
  "Q",
  "MONTH",
  "MM",
  "M",
  "DAYOFYEAR",
  "DY",
  "Y",
  "DAY",
  "DD",
  "D",
  "WEEK",
  "WK",
  "WW",
  "WEEKDAY",
  "DW",
  "W",
  "HOUR",
  "HH",
  "MINUTE",
  "MI",
  "N",
  "SECOND",
  "SS",
  "S",
  "MILLISECOND",
  "MS",
  "MICROSECOND",
  "MCS",
  "NANOSECOND",
  "NS",
  "ISO_WEEK",
  "ISOWK",
  "ISOWW",
  "TZOFFSET",
  "TZ",
]);
