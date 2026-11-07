import { builtinEntries, dateparts } from "./generated/policy.js";
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
export const SQLSERVER_BUILTINS: Readonly<Record<string, SqlServerBuiltin>> = Object.freeze(
  Object.fromEntries(builtinEntries.map((entry) => [entry.name, Object.freeze(entry)])),
);
export const SQLSERVER_DATEPARTS: ReadonlySet<string> = new Set(dateparts);
