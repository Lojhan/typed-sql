import { describe, it, strict } from "poku";
import { grammar, MATURITY_CASES, maturitySnapshot, snapshot } from "./helpers/maturity-corpus.js";

const invalidCases = [
  ["MIN bit rejected", "SELECT MIN(active) AS value FROM dbo.widgets", "MIN(active)"],
  ["MAX bit rejected", "SELECT MAX(active) AS value FROM dbo.widgets", "MAX(active)"],
  ["NULL is not predicate", "SELECT id FROM dbo.widgets WHERE NULL", "NULL"],
  ["CASE NULL is not condition", "SELECT CASE WHEN NULL THEN 1 ELSE 0 END AS value FROM dbo.widgets", "NULL"],
  ["predicate cannot project as BIT", "SELECT (id=1) AS matched FROM dbo.widgets", "id=1"],
  ["EXISTS cannot project as scalar", "SELECT EXISTS(SELECT 1 AS n) AS matched FROM dbo.widgets", "EXISTS"],
  ["predicate cannot cast to BIT", "SELECT CAST(id=1 AS bit) AS matched FROM dbo.widgets", "id=1"],
  ["predicate cannot be COALESCE argument", "SELECT COALESCE(id=1,1) AS value FROM dbo.widgets", "id=1"],
  ["predicate cannot be arithmetic operand", "SELECT 1+(id=1) AS value FROM dbo.widgets", "id=1"],
  ["predicate cannot be assignment value", "UPDATE dbo.widgets SET active=id=1", "id=1"],

  ["missing column", "SELECT missing FROM dbo.widgets", "missing"],
  ["ambiguous unqualified name", "SELECT id FROM dbo.widgets w JOIN dbo.children c ON c.parent_id=w.id", "id"],
  ["ungrouped projection", "SELECT code FROM dbo.widgets GROUP BY quantity", "code"],
  ["WITH TIES without ordering", "SELECT TOP (1) WITH TIES id FROM dbo.widgets", "TOP (1) WITH TIES"],
  ["OFFSET without ordering", "SELECT id FROM dbo.widgets OFFSET 1 ROWS", "1"],
  ["TOP and OFFSET conflict", "SELECT TOP (1) id FROM dbo.widgets ORDER BY id OFFSET 1 ROWS", "TOP (1)"],
  ["AVG bit rejected", "SELECT AVG(active) AS value FROM dbo.widgets", "AVG(active)"],
  ["SUM bit rejected", "SELECT SUM(active) AS value FROM dbo.widgets", "SUM(active)"],
  ["ISNULL missing replacement", "SELECT ISNULL(quantity) AS value FROM dbo.widgets", "ISNULL(quantity)"],
  ["ISNULL extra argument", "SELECT ISNULL(quantity,1,2) AS value FROM dbo.widgets", "ISNULL(quantity,1,2)"],
  ["COALESCE missing alternative", "SELECT COALESCE(quantity) AS value FROM dbo.widgets", "COALESCE(quantity)"],
  ["JSON_VALUE missing path", "SELECT JSON_VALUE(document) AS value FROM dbo.widgets", "JSON_VALUE(document)"],
  ["ROW_NUMBER requires window", "SELECT ROW_NUMBER() AS rank FROM dbo.widgets", "ROW_NUMBER()"],
  // Microsoft TRY_CAST explicitly identifies int -> xml as a forbidden conversion,
  // including TRY_CAST: it raises an error rather than producing NULL.
  [
    "CAST forbidden int XML conversion",
    "SELECT CAST(quantity AS xml) AS value FROM dbo.widgets",
    "CAST(quantity AS xml)",
  ],
  [
    "TRY_CAST forbidden int XML conversion",
    "SELECT TRY_CAST(quantity AS xml) AS value FROM dbo.widgets",
    "TRY_CAST(quantity AS xml)",
  ],
  ["DELETE cannot expose inserted", "DELETE FROM dbo.widgets OUTPUT inserted.id", "inserted.id"],
  ["INSERT width mismatch", "INSERT INTO dbo.children(id,parent_id,amount) VALUES (1,2)", "INSERT"],
  ["INSERT duplicate target", "INSERT INTO dbo.children(id,id,amount) VALUES (1,2,3)", "INSERT"],
  ["unknown update target", "UPDATE dbo.widgets SET missing=1", "missing"],
  ["CTE unknown projection", "WITH a AS (SELECT id FROM dbo.widgets) SELECT missing FROM a", "missing"],
  ["UNION width mismatch", "SELECT id FROM dbo.widgets UNION SELECT id,amount FROM dbo.children", "SELECT id,amount"],
  // ORDER BY requires selected expressions with DISTINCT; WHERE cannot contain an
  // aggregate, and HAVING without GROUP BY operates on one implicit aggregate group.
  ["DISTINCT unselected ordering", "SELECT DISTINCT id FROM dbo.widgets ORDER BY quantity", "quantity"],
  ["WHERE aggregate forbidden", "SELECT id FROM dbo.widgets WHERE SUM(quantity)>1", "SUM(quantity)"],
  ["HAVING ungrouped column", "SELECT id FROM dbo.widgets HAVING quantity>1", "quantity"],
  ["numeric expression is not predicate", "SELECT id FROM dbo.widgets WHERE quantity", "quantity"],
  ["unknown scalar function", "SELECT dbo.unknown_function(id) AS value FROM dbo.widgets", "dbo.unknown_function(id)"],
  ["multiple statements", "SELECT id FROM dbo.widgets; DELETE FROM dbo.widgets", "DELETE"],
  ["dynamic native execution unsupported", "EXEC sp_executesql N'SELECT id FROM dbo.widgets'", "EXEC"],
  ["unattested cross database relation", "SELECT [id] FROM [other].[dbo].[widgets]", "[other].[dbo].[widgets]"],
] as const;

await describe("SQL Server fail-closed maturity and metamorphic soundness", async () => {
  for (const [name, sql, offending] of invalidCases) {
    await it(`rejects ${name} at its original UTF-16 source`, () => {
      const prefix = "-- 😀 astral prefix\r\n";
      const source = prefix + sql;
      const result = grammar.analyze(source, snapshot);
      const errors = result.diagnostics.filter((d) => d.severity === "error");
      if (errors.length === 0) strict.fail(`${name} was accepted: ${JSON.stringify(result.columns)}`);
      strict.equal(result.semantics?.operation.value, "unknown");
      if (!errors.some((d) => source.slice(d.range.start, d.range.end).includes(offending)))
        strict.fail(JSON.stringify(errors));
      for (const error of errors) {
        strict.ok(error.range.start >= prefix.length && error.range.end <= source.length);
        strict.equal(error.range.line, source.slice(0, error.range.start).split("\n").length);
        strict.equal(error.range.column, error.range.start - source.lastIndexOf("\n", error.range.start - 1));
      }
      strict.ok(result.columns.every((c) => !c.tsType.includes("any")));
    });
  }
  for (const test of MATURITY_CASES) {
    await it(`preserves ${test.id} under comments, CRLF and astral UTF-16 shifts`, () => {
      const base = grammar.analyze(test.sql, snapshot);
      const prefix = "/* 😀 comment ; SELECT fake FROM absent */\r\n";
      const changed = grammar.analyze(`${prefix}${test.sql}; -- trailing comment`, snapshot);
      strict.deepEqual(changed.diagnostics, []);
      strict.deepEqual(
        changed.columns.map(({ range: _range, ...c }) => c),
        base.columns.map(({ range: _range, ...c }) => c),
      );
      strict.deepEqual(changed.parameters, base.parameters);
      strict.equal(changed.semantics?.operation.value, base.semantics?.operation.value);
      strict.equal(changed.semantics?.cardinality.maximum, base.semantics?.cardinality.maximum);
      for (const [index, column] of changed.columns.entries()) {
        strict.equal(column.range.start, base.columns[index]!.range.start + prefix.length);
        strict.equal(column.range.end, base.columns[index]!.range.end + prefix.length);
        strict.equal(column.range.line, 2);
      }
    });
  }
  await it("uses real collation sensitivity for quoted and unquoted catalog names", () => {
    const source = "SELECT ID FROM DBO.WIDGETS";
    strict.deepEqual(grammar.analyze(source, snapshot).diagnostics, []);
    const cs = maturitySnapshot("17.0.5035.5", "Latin1_General_100_CS_AS");
    const rejected = grammar.analyze(source, cs);
    strict.ok(rejected.diagnostics.some((d) => d.severity === "error"));
    strict.equal(rejected.semantics?.operation.value, "unknown");
    const exact = grammar.analyze("SELECT [id] FROM [dbo].[widgets]", cs);
    strict.deepEqual(exact.diagnostics, []);
    strict.equal(exact.columns[0]?.tsType, "bigint");
  });
  await it("does not assign native JSON support to SQL Server 2022", () => {
    const result = grammar.analyze(
      "SELECT JSON_OBJECT('id':id RETURNING JSON) AS value FROM dbo.widgets",
      maturitySnapshot("16.0.4250.1", "Latin1_General_100_CI_AS", 160),
    );
    strict.ok(result.diagnostics.some((d) => d.code === "TSQ401"));
    strict.equal(result.semantics?.operation.value, "unknown");
  });
  await it("requires qualified engine and complete session evidence even for a plain projection", () => {
    const { server: _server, ...withoutServer } = snapshot;
    for (const schema of [
      maturitySnapshot("18.0.1000.0"),
      withoutServer,
      { ...snapshot, server: { ...snapshot.server, settings: { compatibilityLevel: 170 } } },
    ]) {
      const result = grammar.analyze("SELECT id FROM dbo.widgets", schema);
      strict.ok(result.diagnostics.some((d) => d.severity === "error"));
      strict.equal(result.semantics?.operation.value, "unknown");
    }
  });
  await it("keeps unproven XML methods and opaque SQL types conservative", () => {
    const xml = grammar.analyze("SELECT payload.value('(root/id)[1]','int') AS value FROM dbo.widgets", snapshot);
    strict.ok(xml.diagnostics.some((d) => d.severity === "error") || xml.columns.some((c) => c.tsType === "unknown"));
    const opaque = {
      ...snapshot,
      tables: {
        ...snapshot.tables,
        unproven: {
          name: "unproven",
          schema: "dbo",
          columns: { shape: { name: "shape", databaseType: "geography", tsType: "unknown", nullable: false } },
        },
      },
    };
    const result = grammar.analyze("SELECT shape FROM dbo.unproven", opaque);
    strict.ok(result.diagnostics.some((d) => d.severity === "error") || result.columns[0]?.tsType === "unknown");
    strict.ok(result.columns.every((c) => c.tsType !== "any"));
  });
  await it("contains malformed lexical input rather than throwing or returning an optimistic query", () => {
    for (const source of [
      "",
      "SELECT 'unterminated",
      "SELECT [unterminated",
      "SELECT /* unterminated",
      "SELECT id FROM dbo.widgets WHERE id=@",
      "SELECT id FROM dbo.widgets\u0000",
    ]) {
      const result = grammar.analyze(source, snapshot);
      strict.ok(result.diagnostics.some((d) => d.severity === "error"));
      strict.equal(result.semantics?.operation.value, "unknown");
      for (const diagnostic of result.diagnostics) {
        strict.ok(diagnostic.range.start >= 0 && diagnostic.range.end <= source.length);
      }
    }
  });
  // https://learn.microsoft.com/en-us/sql/t-sql/statements/create-function-transact-sql#remarks
  await it("does not turn an unqualified scalar UDF name into a SQL Server builtin", () => {
    const schema = {
      ...snapshot,
      functions: {
        make: {
          name: "make",
          schema: "dbo",
          argumentTypes: ["int"],
          databaseReturnType: "bigint",
          returnType: "bigint",
          nullable: false,
        },
      },
    };
    const valid = grammar.analyze("SELECT dbo.make(quantity) AS value FROM dbo.widgets", schema);
    strict.deepEqual(valid.diagnostics, []);
    strict.equal(valid.columns[0]?.tsType, "bigint");
    const unqualified = grammar.analyze("SELECT make(quantity) AS value FROM dbo.widgets", schema);
    strict.ok(unqualified.diagnostics.some((d) => d.severity === "error"));
    strict.equal(unqualified.semantics?.operation.value, "unknown");
  });

  // Vendor rules: recursive/derived names and member types, OVER frame boundaries,
  // TOP/OFFSET/FETCH limits and OPENJSON AS JSON targets are engine constraints.
  // https://learn.microsoft.com/en-us/sql/t-sql/queries/with-common-table-expression-transact-sql
  // https://learn.microsoft.com/en-us/sql/t-sql/queries/select-over-clause-transact-sql
  // https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql
  // https://learn.microsoft.com/en-us/sql/t-sql/queries/select-order-by-clause-transact-sql
  // https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql
  for (const [name, source] of [
    [
      "duplicate CTE names",
      "WITH a AS (SELECT id FROM dbo.widgets),a AS (SELECT id FROM dbo.widgets) SELECT id FROM a",
    ],
    ["duplicate CTE columns", "WITH a(x,x) AS (SELECT id,quantity FROM dbo.widgets) SELECT 1 AS value"],
    ["CTE column width", "WITH a(x,y) AS (SELECT id FROM dbo.widgets) SELECT x FROM a"],
    [
      "recursive UNION requires ALL",
      "WITH a(n) AS (SELECT CAST(1 AS int) AS n UNION SELECT n+1 AS n FROM a WHERE n<3) SELECT n FROM a",
    ],
    [
      "recursive member type equality",
      "WITH a(n) AS (SELECT CAST(1 AS int) AS n UNION ALL SELECT CAST(n+1 AS bigint) AS n FROM a WHERE n<3) SELECT n FROM a",
    ],
    ["duplicate derived column aliases", "SELECT 1 AS value FROM (SELECT id,quantity FROM dbo.widgets) d(x,x)"],
    ["derived column width", "SELECT d.x FROM (SELECT id FROM dbo.widgets) d(x,y)"],
    ["non-lateral derived correlation", "SELECT w.id FROM dbo.widgets w CROSS JOIN (SELECT w.id AS id) d"],
    ["scalar subquery width", "SELECT (SELECT id,amount FROM dbo.children) AS value FROM dbo.widgets"],
    ["IN subquery width", "SELECT id FROM dbo.widgets WHERE id IN (SELECT id,amount FROM dbo.children)"],
    ["nested aggregate", "SELECT SUM(MAX(quantity)) AS value FROM dbo.widgets"],
    ["ROW_NUMBER missing ORDER BY", "SELECT ROW_NUMBER() OVER () AS value FROM dbo.widgets"],
    [
      "RANGE does not accept numeric PRECEDING",
      "SELECT SUM(quantity) OVER (ORDER BY id RANGE 1 PRECEDING) AS value FROM dbo.widgets",
    ],
    ["negative ROWS offset", "SELECT SUM(quantity) OVER (ORDER BY id ROWS -1 PRECEDING) AS value FROM dbo.widgets"],
    [
      "reversed ROWS frame",
      "SELECT SUM(quantity) OVER (ORDER BY id ROWS BETWEEN 1 FOLLOWING AND 1 PRECEDING) AS value FROM dbo.widgets",
    ],
    ["negative TOP", "SELECT TOP (-1) id FROM dbo.widgets"],
    ["TOP PERCENT maximum", "SELECT TOP (101) PERCENT id FROM dbo.widgets"],
    ["negative OFFSET", "SELECT id FROM dbo.widgets ORDER BY id OFFSET -1 ROWS"],
    ["zero FETCH", "SELECT id FROM dbo.widgets ORDER BY id OFFSET 0 ROWS FETCH NEXT 0 ROWS ONLY"],
    ["OPENJSON needs input", "SELECT j.[key] FROM OPENJSON() j"],
    ["OPENJSON AS JSON requires nvarchar max", "SELECT j.items FROM OPENJSON(N'{}') WITH(items int AS JSON) j"],
    ["STRING_SPLIT ordinal is literal", "SELECT value FROM STRING_SPLIT('a,b',',',@__typed_sql_1)"],
    ["unknown table function", "SELECT x.value FROM dbo.unknown_table(1) x"],
    ["unsupported datepart", "SELECT DATEADD(moon,1,CAST('2026-01-01' AS date)) AS value"],
  ] as const) {
    await it(`rejects ${name} without optimistic semantics`, () => {
      const result = grammar.analyze(source, snapshot);
      if (!result.diagnostics.some((d) => d.severity === "error")) strict.fail(`${name} accepted: ${source}`);
      strict.equal(result.semantics?.operation.value, "unknown");
      for (const diagnostic of result.diagnostics)
        strict.ok(diagnostic.range.start >= 0 && diagnostic.range.end <= source.length);
    });
  }
});
