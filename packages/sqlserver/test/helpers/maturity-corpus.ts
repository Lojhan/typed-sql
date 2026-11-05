import type { ExpectedColumn, ExpectedParameter } from "@typed-sql/conformance/v2";
import { sqlServerServerEvidence, sqlserver } from "../../src/browser.js";

/** Primary vendor references are part of the oracle; expectations never come from resolver output. */
export const VENDOR = {
  numeric: "https://learn.microsoft.com/en-us/sql/t-sql/data-types/precision-scale-and-length-transact-sql",
  sum: "https://learn.microsoft.com/en-us/sql/t-sql/functions/sum-transact-sql",
  avg: "https://learn.microsoft.com/en-us/sql/t-sql/functions/avg-transact-sql",
  count: "https://learn.microsoft.com/en-us/sql/t-sql/functions/count-big-transact-sql",
  isnull: "https://learn.microsoft.com/en-us/sql/t-sql/functions/isnull-transact-sql",
  coalesce: "https://learn.microsoft.com/en-us/sql/t-sql/language-elements/coalesce-transact-sql",
  trycast: "https://learn.microsoft.com/en-us/sql/t-sql/functions/try-cast-transact-sql",
  from: "https://learn.microsoft.com/en-us/sql/t-sql/queries/from-transact-sql",
  top: "https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql",
  order: "https://learn.microsoft.com/en-us/sql/t-sql/queries/select-order-by-clause-transact-sql",
  window: "https://learn.microsoft.com/en-us/sql/t-sql/functions/row-number-transact-sql",
  output: "https://learn.microsoft.com/en-us/sql/t-sql/queries/output-clause-transact-sql",
  json: "https://learn.microsoft.com/en-us/sql/t-sql/functions/json-value-transact-sql",
  xml: "https://learn.microsoft.com/en-us/sql/t-sql/xml/value-method-xml-data-type",
} as const;
export const DDL = [
  "CREATE TABLE dbo.widgets (id bigint NOT NULL PRIMARY KEY, code nvarchar(40) NOT NULL, quantity int NOT NULL, tiny tinyint NOT NULL, amount decimal(12,2) NOT NULL, adjustment decimal(9,3) NOT NULL, optional_qty int NULL, parent_id bigint NULL, document nvarchar(max) NOT NULL, payload xml NULL, active bit NOT NULL)",
  "CREATE TABLE dbo.children (id bigint NOT NULL PRIMARY KEY, parent_id bigint NOT NULL, amount decimal(12,2) NOT NULL)",
] as const;
const column = (name: string, databaseType: string, tsType: string, nullable = false) => ({
  name,
  databaseType,
  tsType,
  nullable,
});
export const widgets = Object.fromEntries(
  [
    column("id", "bigint", "bigint"),
    column("code", "nvarchar(40)", "string"),
    column("quantity", "int", "number"),
    column("tiny", "tinyint", "number"),
    column("amount", "decimal(12,2)", "string"),
    column("adjustment", "decimal(9,3)", "string"),
    column("optional_qty", "int", "number", true),
    column("parent_id", "bigint", "bigint", true),
    column("document", "nvarchar(max)", "string"),
    column("payload", "xml", "string", true),
    column("active", "bit", "boolean"),
  ].map((c) => [c.name, c]),
);
export function maturitySnapshot(
  version = "17.0.5035.5",
  collation = "Latin1_General_100_CI_AS",
  compatibilityLevel = 170,
) {
  return {
    formatVersion: 1 as const,
    dialect: "sqlserver" as const,
    server: sqlServerServerEvidence(version, {
      compatibilityLevel,
      collation,
      defaultSchema: "dbo",
      quotedIdentifier: true,
      ansiWarnings: true,
      arithAbort: true,
      concatNullYieldsNull: true,
      dateFirst: 7,
      dateFormat: "mdy",
      language: "us_english",
    }),
    tables: {
      widgets: { schema: "dbo", name: "widgets", columns: widgets },
      children: {
        schema: "dbo",
        name: "children",
        columns: Object.fromEntries(
          [
            column("id", "bigint", "bigint"),
            column("parent_id", "bigint", "bigint"),
            column("amount", "decimal(12,2)", "string"),
          ].map((c) => [c.name, c]),
        ),
      },
    },
  };
}
export const grammar = sqlserver();
export const snapshot = maturitySnapshot();
export const target = { grammar: "sqlserver", grammarVersion: grammar.grammarVersion, databaseVersion: "17.0.5035.5" };
export interface MaturityCase {
  readonly id: string;
  readonly feature: string;
  readonly sql: string;
  readonly rows: readonly ExpectedColumn[];
  readonly parameters?: readonly ExpectedParameter[];
  readonly vendor: string;
  readonly operation?: "read" | "write";
  readonly maximum?: 0 | 1 | "many";
}
const row = (name: string, tsType: string, nullable: boolean, databaseType?: string): ExpectedColumn => ({
  name,
  tsType,
  nullable,
  ...(databaseType ? { databaseType } : {}),
});
const value = (tsType: string, databaseType?: string, nullable = false) => [
  row("value", tsType, nullable, databaseType),
];
export const MATURITY_CASES: readonly MaturityCase[] = [
  {
    id: "integer-division",
    feature: "coercions",
    sql: "SELECT quantity / 2 AS value FROM dbo.widgets",
    rows: value("number", "int"),
    vendor: VENDOR.numeric,
  },
  {
    id: "decimal-add",
    feature: "coercions",
    sql: "SELECT amount + adjustment AS value FROM dbo.widgets",
    rows: value("string", "decimal(14,3)"),
    vendor: VENDOR.numeric,
  },
  {
    id: "decimal-multiply",
    feature: "coercions",
    sql: "SELECT amount * adjustment AS value FROM dbo.widgets",
    rows: value("string", "decimal(22,5)"),
    vendor: VENDOR.numeric,
  },
  {
    id: "decimal-divide",
    feature: "coercions",
    sql: "SELECT amount / adjustment AS value FROM dbo.widgets",
    rows: value("string", "decimal(25,12)"),
    vendor: VENDOR.numeric,
  },
  {
    id: "decimal-remainder",
    feature: "coercions",
    sql: "SELECT amount % adjustment AS value FROM dbo.widgets",
    rows: value("string", "decimal(9,3)"),
    vendor: VENDOR.numeric,
  },
  {
    id: "sum-tiny-promotes",
    feature: "aggregates",
    sql: "SELECT SUM(tiny) AS value FROM dbo.widgets",
    rows: value("number", "int", true),
    vendor: VENDOR.sum,
    maximum: 1,
  },
  {
    id: "sum-decimal-widens",
    feature: "aggregates",
    sql: "SELECT SUM(amount) AS value FROM dbo.widgets",
    rows: value("string", "decimal(38,2)", true),
    vendor: VENDOR.sum,
    maximum: 1,
  },
  {
    id: "avg-int-truncates",
    feature: "aggregates",
    sql: "SELECT AVG(quantity) AS value FROM dbo.widgets",
    rows: value("number", "int", true),
    vendor: VENDOR.avg,
    maximum: 1,
  },
  {
    id: "avg-decimal-widens",
    feature: "aggregates",
    sql: "SELECT AVG(adjustment) AS value FROM dbo.widgets",
    rows: value("string", "decimal(38,6)", true),
    vendor: VENDOR.avg,
    maximum: 1,
  },
  {
    id: "count-big",
    feature: "aggregates",
    sql: "SELECT COUNT_BIG(*) AS value FROM dbo.widgets",
    rows: value("bigint", "bigint"),
    vendor: VENDOR.count,
    maximum: 1,
  },
  {
    id: "isnull-keeps-first-type",
    feature: "nullability",
    sql: "SELECT ISNULL(optional_qty, amount) AS value FROM dbo.widgets",
    rows: value("number", "int"),
    vendor: VENDOR.isnull,
  },
  {
    id: "coalesce-precedence",
    feature: "nullability",
    sql: "SELECT COALESCE(optional_qty, amount) AS value FROM dbo.widgets",
    rows: value("string", "decimal(12,2)"),
    vendor: VENDOR.coalesce,
  },
  {
    id: "try-cast-null",
    feature: "casts",
    sql: "SELECT TRY_CAST(code AS int) AS value FROM dbo.widgets",
    rows: value("number", "int", true),
    vendor: VENDOR.trycast,
  },
  {
    id: "try-convert-null",
    feature: "casts",
    sql: "SELECT TRY_CONVERT(datetime2(7), code) AS value FROM dbo.widgets",
    rows: value("string", "datetime2(7)", true),
    vendor: VENDOR.trycast,
  },
  {
    id: "left-join",
    feature: "joins",
    sql: "SELECT w.id, c.amount FROM dbo.widgets w LEFT JOIN dbo.children c ON c.parent_id=w.id",
    rows: [row("id", "bigint", false, "bigint"), row("amount", "string", true, "decimal(12,2)")],
    vendor: VENDOR.from,
  },
  {
    id: "full-join",
    feature: "joins",
    sql: "SELECT w.id AS widget_id,c.id AS child_id FROM dbo.widgets w FULL JOIN dbo.children c ON c.parent_id=w.id",
    rows: [row("widget_id", "bigint", true, "bigint"), row("child_id", "bigint", true, "bigint")],
    vendor: VENDOR.from,
  },
  {
    id: "cross-apply-correlated",
    feature: "apply",
    sql: "SELECT w.id,a.amount FROM dbo.widgets w CROSS APPLY (SELECT c.amount FROM dbo.children c WHERE c.parent_id=w.id) a",
    rows: [row("id", "bigint", false, "bigint"), row("amount", "string", false, "decimal(12,2)")],
    vendor: VENDOR.from,
  },
  {
    id: "outer-apply-correlated",
    feature: "apply",
    sql: "SELECT w.id,a.amount FROM dbo.widgets w OUTER APPLY (SELECT c.amount FROM dbo.children c WHERE c.parent_id=w.id) a",
    rows: [row("id", "bigint", false, "bigint"), row("amount", "string", true, "decimal(12,2)")],
    vendor: VENDOR.from,
  },
  {
    id: "cte-column-list",
    feature: "ctes",
    sql: "WITH selected(widget_id) AS (SELECT id FROM dbo.widgets) SELECT widget_id FROM selected",
    rows: [row("widget_id", "bigint", false, "bigint")],
    vendor: VENDOR.from,
  },
  {
    id: "top-one",
    feature: "top",
    sql: "SELECT TOP (1) id FROM dbo.widgets ORDER BY id",
    rows: [row("id", "bigint", false, "bigint")],
    vendor: VENDOR.top,
    maximum: 1,
  },
  {
    id: "top-with-ties",
    feature: "top",
    sql: "SELECT TOP (1) WITH TIES id FROM dbo.widgets ORDER BY quantity",
    rows: [row("id", "bigint", false, "bigint")],
    vendor: VENDOR.top,
  },
  {
    id: "offset-fetch",
    feature: "pagination",
    sql: "SELECT id FROM dbo.widgets ORDER BY id OFFSET 2 ROWS FETCH NEXT 4 ROWS ONLY",
    rows: [row("id", "bigint", false, "bigint")],
    vendor: VENDOR.order,
  },
  {
    id: "window-rank",
    feature: "windows",
    sql: "SELECT id,ROW_NUMBER() OVER (PARTITION BY active ORDER BY quantity DESC) AS rank FROM dbo.widgets",
    rows: [row("id", "bigint", false, "bigint"), row("rank", "bigint", false, "bigint")],
    vendor: VENDOR.window,
  },
  {
    id: "insert-output",
    feature: "output",
    sql: "INSERT INTO dbo.children(id,parent_id,amount) OUTPUT inserted.id VALUES (1,2,3),(4,5,6)",
    rows: [row("id", "bigint", false, "bigint")],
    vendor: VENDOR.output,
    operation: "write",
  },
  {
    id: "update-output-old-new",
    feature: "output",
    sql: "UPDATE dbo.widgets SET quantity=quantity+1 OUTPUT deleted.quantity AS old_quantity,inserted.quantity AS new_quantity WHERE id=1",
    rows: [row("old_quantity", "number", false, "int"), row("new_quantity", "number", false, "int")],
    vendor: VENDOR.output,
    operation: "write",
  },
  {
    id: "delete-output",
    feature: "output",
    sql: "DELETE FROM dbo.children OUTPUT deleted.id WHERE parent_id=1",
    rows: [row("id", "bigint", false, "bigint")],
    vendor: VENDOR.output,
    operation: "write",
  },
  {
    id: "json-scalar",
    feature: "json",
    sql: "SELECT JSON_VALUE(document,'$.name') AS value FROM dbo.widgets",
    rows: value("string", "nvarchar(4000)", true),
    vendor: VENDOR.json,
  },
  {
    id: "json-fragment",
    feature: "json",
    sql: "SELECT JSON_QUERY(document,'$.items') AS value FROM dbo.widgets",
    rows: value("string", "nvarchar(max)", true),
    vendor: VENDOR.json,
  },
  {
    id: "xml-storage",
    feature: "xml",
    sql: "SELECT payload FROM dbo.widgets",
    rows: [row("payload", "string", true, "xml")],
    vendor: VENDOR.xml,
  },
  {
    id: "known-scalar-functions",
    feature: "builtins",
    sql: "SELECT LEN(code) AS length,DATALENGTH(code) AS bytes,ABS(quantity) AS magnitude FROM dbo.widgets",
    rows: [
      row("length", "number", false, "int"),
      row("bytes", "number", false, "int"),
      row("magnitude", "number", false, "int"),
    ],
    vendor: VENDOR.numeric,
  },

  {
    id: "len-max-is-bigint",
    feature: "builtins",
    sql: "SELECT LEN(document) AS value FROM dbo.widgets",
    rows: value("bigint", "bigint"),
    vendor: "https://learn.microsoft.com/en-us/sql/t-sql/functions/len-transact-sql",
  },
  {
    id: "datalength-max-is-bigint",
    feature: "builtins",
    sql: "SELECT DATALENGTH(document) AS value FROM dbo.widgets",
    rows: value("bigint", "bigint"),
    vendor: "https://learn.microsoft.com/en-us/sql/t-sql/functions/datalength-transact-sql",
  },
  {
    id: "abs-decimal-widens",
    feature: "builtins",
    sql: "SELECT ABS(amount) AS value FROM dbo.widgets",
    rows: value("string", "decimal(38,2)"),
    vendor: "https://learn.microsoft.com/en-us/sql/t-sql/functions/abs-transact-sql",
  },
  {
    id: "round-decimal-retains-scale",
    feature: "builtins",
    sql: "SELECT ROUND(amount,1) AS value FROM dbo.widgets",
    rows: value("string", "decimal(12,2)"),
    vendor: "https://learn.microsoft.com/en-us/sql/t-sql/functions/round-transact-sql",
  },
  {
    id: "dateadd-retains-date",
    feature: "builtins",
    sql: "SELECT DATEADD(day,quantity,CAST('2026-01-01' AS date)) AS value FROM dbo.widgets",
    rows: value("string", "date"),
    vendor: "https://learn.microsoft.com/en-us/sql/t-sql/functions/dateadd-transact-sql",
  },
  {
    id: "datediff-big",
    feature: "builtins",
    sql: "SELECT DATEDIFF_BIG(day,CAST('2026-01-01' AS date),CAST('2026-02-01' AS date)) AS value FROM dbo.widgets",
    rows: value("bigint", "bigint"),
    vendor: "https://learn.microsoft.com/en-us/sql/t-sql/functions/datediff-big-transact-sql",
  },
  {
    id: "nullif-nullability",
    feature: "nullability",
    sql: "SELECT NULLIF(quantity,0) AS value FROM dbo.widgets",
    rows: value("number", "int", true),
    vendor: "https://learn.microsoft.com/en-us/sql/t-sql/language-elements/nullif-transact-sql",
  },
  {
    id: "case-type-precedence",
    feature: "coercions",
    sql: "SELECT CASE WHEN active=1 THEN quantity ELSE amount END AS value FROM dbo.widgets",
    rows: value("string", "decimal(12,2)"),
    vendor: VENDOR.coalesce,
  },

  {
    id: "searched-case-predicate",
    feature: "conditionals",
    sql: "SELECT CASE WHEN id=1 THEN quantity ELSE optional_qty END AS value FROM dbo.widgets",
    rows: value("number", "int", true),
    vendor: "https://learn.microsoft.com/en-us/sql/t-sql/language-elements/case-transact-sql",
  },
  {
    id: "iif-predicate",
    feature: "conditionals",
    sql: "SELECT IIF(id=1,quantity,optional_qty) AS value FROM dbo.widgets",
    rows: value("number", "int", true),
    vendor: "https://learn.microsoft.com/en-us/sql/t-sql/functions/logical-functions-iif-transact-sql",
  },
];
