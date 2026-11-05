import { describe, it, strict } from "poku";
import { sqlServerServerEvidence, sqlserver } from "../src/index.js";

const server = sqlServerServerEvidence("17.0.5035.5", {
  compatibilityLevel: 170,
  collation: "Latin1_General_100_CI_AS",
  defaultSchema: "dbo",
  quotedIdentifier: true,
  ansiWarnings: true,
  arithAbort: true,
  concatNullYieldsNull: true,
  dateFirst: 7,
  dateFormat: "mdy",
  language: "us_english",
});
const snapshot = {
  formatVersion: 1,
  dialect: "sqlserver",
  server,
  tables: {
    orders: {
      schema: "dbo",
      name: "orders",
      columns: {
        id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
        status: { name: "status", databaseType: "nvarchar(40)", tsType: "string", nullable: false },
        amount: { name: "amount", databaseType: "decimal(38,10)", tsType: "string", nullable: false },
        name: { name: "name", databaseType: "nvarchar(100)", tsType: "string", nullable: true },
      },
    },
    items: {
      schema: "dbo",
      name: "items",
      columns: {
        order_id: { name: "order_id", databaseType: "bigint", tsType: "bigint", nullable: false },
        amount: { name: "amount", databaseType: "decimal(20,4)", tsType: "string", nullable: false },
      },
    },
  },
} as const;
const grammar = sqlserver();
function analyze(source: string) {
  return grammar.analyze(source, snapshot);
}
await describe("SQL Server native inference", async () => {
  await it("matches qualified four-engine native string result dimensions", () => {
    // Native DMF oracle run42127162293, SQL Server14–17; physical widths matter before DML execution.
    const cases: readonly (readonly [string, string])[] = [
      ["LOWER(status)", "nvarchar(40)"],
      ["UPPER(status)", "nvarchar(40)"],
      ["LTRIM(status)", "nvarchar(40)"],
      ["RTRIM(status)", "nvarchar(40)"],
      ["TRIM(status)", "nvarchar(40)"],
      ["REVERSE(status)", "nvarchar(40)"],
      ["STUFF(status,1,1,N'x')", "nvarchar(40)"],
      ["LEFT(status,2)", "nvarchar(2)"],
      ["RIGHT(status,2)", "nvarchar(2)"],
      ["SUBSTRING(status,1,2)", "nvarchar(2)"],
      ["REPLICATE(status,2)", "nvarchar(80)"],
      ["CHAR(65)", "char(1)"],
      ["NCHAR(65)", "nchar(1)"],
      ["SPACE(2)", "varchar(2)"],
      ["QUOTENAME(status)", "nvarchar(258)"],
      ["SOUNDEX(status)", "varchar(5)"],
      ["STR(id)", "varchar(10)"],
      ["FORMAT(id,N'N2',N'en-US')", "nvarchar(4000)"],
      ["REPLACE(status,N'x',N'xx')", "nvarchar(4000)"],
      ["TRANSLATE(status,N'xy',N'ab')", "nvarchar(4000)"],
      ["CONCAT(status,N'x')", "nvarchar(41)"],
      ["CONCAT_WS(N',',status,N'x')", "nvarchar(42)"],
      ["LOWER(CAST(status AS nvarchar(max)))", "nvarchar(max)"],
      ["REPLACE(CAST(status AS nvarchar(max)),N'x',N'y')", "nvarchar(max)"],
      ["REPLICATE(CAST(status AS nvarchar(max)),2)", "nvarchar(max)"],
      ["CONCAT(status,CAST(status AS nvarchar(max)))", "nvarchar(max)"],
    ];
    for (const [expression, expected] of cases) {
      const result = analyze(`SELECT ${expression} AS value FROM dbo.orders`);
      strict.deepEqual(result.diagnostics, [], expression);
      strict.equal(result.columns[0]?.databaseType?.split(" COLLATE ")[0], expected, expression);
    }
    for (const expression of ["LEFT(status,id)", "REPLICATE(status,-1)", "CONCAT(status,id)", "LOWER(id)"]) {
      strict.ok(analyze(`SELECT ${expression} AS value FROM dbo.orders`).diagnostics.length > 0, expression);
    }
  });

  await it("does not treat provisional unknown parameter nullability as catalog evidence", () => {
    const result = analyze("SELECT id FROM dbo.orders WHERE id=@__typed_sql_1 AND name=@__typed_sql_2");
    strict.deepEqual(result.diagnostics, []);
    strict.deepEqual(
      result.parameters.map((parameter) => [parameter.index, parameter.nullable]),
      [
        [1, false],
        [2, true],
      ],
    );
    const cast = analyze("SELECT CAST(@__typed_sql_1 AS bigint) AS id");
    strict.equal(cast.parameters[0]?.nullable, true);
    strict.equal(cast.columns[0]?.nullable, true);
    strict.equal(analyze("SELECT CAST(NULL AS bigint) AS id").columns[0]?.nullable, true);
    strict.equal(analyze("SELECT CAST(1 AS bigint) AS id").columns[0]?.nullable, false);
  });

  await it("retains text-family and MAX metadata while declining unqualified length coercions", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["LOWER(CAST(status AS varchar(40)))", "varchar(40)"],
      ["REPLACE(CAST(status AS varchar(40)),'x','y')", "varchar(8000)"],
      ["TRANSLATE(CAST(status AS varchar(40)),'xy','ab')", "varchar(8000)"],
      ["STRING_ESCAPE(status,'json')", "nvarchar(max)"],
      ["CONCAT(CAST(status AS varchar(40)),'x')", "varchar(41)"],
      ["CONCAT_WS(',',CAST(status AS varchar(40)),'x')", "varchar(42)"],
      ["STR(id,12,2)", "varchar(12)"],
      ["REPLACE(CAST(status AS varchar(max)),'x','y')", "varchar(max)"],
    ];
    for (const [expression, expected] of cases) {
      const result = analyze(`SELECT ${expression} AS value FROM dbo.orders`);
      strict.deepEqual(result.diagnostics, [], expression);
      strict.equal(result.columns[0]?.databaseType?.split(" COLLATE ")[0], expected, expression);
    }
    for (const expression of ["SPACE(id)", "STR(id,id)", "LEFT(status,1.5)", "CONCAT(NULL,status)", "LOWER(NULL)"]) {
      strict.ok(analyze(`SELECT ${expression} AS value FROM dbo.orders`).diagnostics.length > 0, expression);
    }
    for (const expression of ["CONCAT(@__typed_sql_1,N'x')", "CONCAT_WS(N',',@__typed_sql_1,N'x')"]) {
      const result = analyze(`SELECT ${expression} AS value`);
      strict.deepEqual(result.diagnostics, []);
      strict.equal(result.columns[0]?.databaseType, "nvarchar(max)");
      strict.equal(result.parameters[0]?.databaseType, "nvarchar(max)");
    }
    const unscoped = grammar.analyze("SELECT CONCAT('a','b') AS value", {
      formatVersion: 1,
      dialect: "sqlserver",
      server,
      tables: {},
    });
    strict.deepEqual(unscoped.diagnostics, []);
    strict.equal(unscoped.columns[0]?.databaseType, "varchar(2)");
  });

  await it("proves repeated INSERT VALUES shapes and distinguishes output projection changes", () => {
    const source =
      "INSERT INTO dbo.orders(id,status,amount) OUTPUT inserted.id VALUES (@__typed_sql_1,@__typed_sql_2,@__typed_sql_3),(@__typed_sql_4,@__typed_sql_5,@__typed_sql_6)";
    const position = source.indexOf("@__typed_sql_1");
    const analysis = grammar.analyze(source, snapshot, undefined, {
      repeatedFragmentRanges: [{ start: position, end: source.length }],
    });
    strict.deepEqual(analysis.diagnostics, []);
    strict.equal(analysis.repeatedResultShapeStable, true);
    strict.deepEqual(
      analysis.columns.map((column) => column.name),
      ["id"],
    );
    strict.equal(analysis.parameters.length, 6);
  });
  await it("resolves native colon-key JSON constructors and update FROM aliases", () => {
    strict.deepEqual(
      analyze("UPDATE o SET status=@__typed_sql_1 OUTPUT inserted.id FROM dbo.orders o WHERE o.id=@__typed_sql_2")
        .diagnostics,
      [],
    );
    const json = analyze("SELECT JSON_OBJECT('id':id,'name':name NULL ON NULL) AS document FROM dbo.orders");
    strict.deepEqual(json.diagnostics, []);
    strict.equal(json.columns[0]?.tsType, "string");
    strict.equal(json.columns[0]?.json?.shape.kind, "object");
    strict.ok(analyze("SELECT JSON_OBJECT('id',id) AS document FROM dbo.orders").diagnostics.length > 0);
  });

  await it("preserves row names, exact decimal policy and occurrence targets", () => {
    const query = analyze(
      "SELECT o.id,o.amount,o.name FROM dbo.orders o WHERE o.id=@__typed_sql_1 AND o.status=@__typed_sql_2",
    );
    strict.deepEqual(query.diagnostics, []);
    strict.deepEqual(
      query.columns.map((c) => [c.name, c.tsType, c.nullable]),
      [
        ["id", "bigint", false],
        ["amount", "string", false],
        ["name", "string", true],
      ],
    );
    strict.deepEqual(
      query.parameters.map((p) => [p.index, p.tsType, p.databaseType]),
      [
        [1, "bigint", "bigint"],
        [2, "string", "nvarchar(40) COLLATE Latin1_General_100_CI_AS"],
      ],
    );
  });
  await it("resolves APPLY, CTEs, windows and pagination with their scopes", () => {
    for (const query of [
      "WITH c AS (SELECT id,status FROM dbo.orders) SELECT c.id,c.status FROM c WHERE c.id=@__typed_sql_1",
      "SELECT o.id,x.total FROM dbo.orders o OUTER APPLY (SELECT SUM(i.amount) AS total FROM dbo.items i WHERE i.order_id=o.id) x",
      "SELECT id,ROW_NUMBER() OVER(ORDER BY id) AS n FROM dbo.orders ORDER BY id OFFSET @__typed_sql_1 ROWS FETCH NEXT @__typed_sql_2 ROWS ONLY",
    ]) {
      const result = analyze(query);
      strict.deepEqual(result.diagnostics, [], query);
      strict.ok(result.columns.length >= 2);
    }
  });
  await it("resolves output scopes and matching insert/update parameters", () => {
    const insert = analyze(
      "INSERT INTO dbo.orders(id,status,amount) OUTPUT inserted.id,inserted.amount VALUES(@__typed_sql_1,@__typed_sql_2,@__typed_sql_3)",
    );
    strict.deepEqual(insert.diagnostics, []);
    strict.equal(insert.resultKind, "rows");
    strict.deepEqual(
      insert.parameters.map((p) => p.databaseType),
      ["bigint", "nvarchar(40) COLLATE Latin1_General_100_CI_AS", "decimal(38,10)"],
    );
    const update = analyze(
      "UPDATE dbo.orders SET amount=@__typed_sql_1 OUTPUT inserted.amount,deleted.amount AS previous WHERE id=@__typed_sql_2",
    );
    strict.deepEqual(update.diagnostics, []);
    strict.equal(update.columns[1]?.tsType, "string");
  });
  await it("uses T-SQL count/aggregate/nullability and ISNULL native rules", () => {
    const result = analyze(
      "SELECT COUNT(*) AS n,COUNT_BIG(*) AS wide,SUM(amount) AS total,AVG(amount) AS mean FROM dbo.orders",
    );
    strict.deepEqual(result.diagnostics, []);
    strict.deepEqual(
      result.columns.map((c) => [c.name, c.databaseType, c.nullable]),
      [
        ["n", "int", false],
        ["wide", "bigint", false],
        ["total", "decimal(38,10)", true],
        ["mean", "decimal(38,10)", true],
      ],
    );
    const filled = analyze("SELECT ISNULL(name,N'none') AS name FROM dbo.orders");
    strict.deepEqual(filled.diagnostics, []);
    strict.equal(filled.columns[0]?.nullable, false);
  });
  await it("fails closed for unknown names, ambiguity, conflicting targets and invalid predicates", () => {
    for (const source of [
      "SELECT missing FROM dbo.orders",
      "SELECT id FROM missing",
      "SELECT id FROM dbo.orders a JOIN dbo.orders b ON a.id=b.id",
      "SELECT id FROM dbo.orders WHERE amount=@__typed_sql_1 AND status=@__typed_sql_1",
      "SELECT id FROM dbo.orders WHERE CAST(1 AS bit)",
      "SELECT id,COUNT(*) AS n FROM dbo.orders",
    ]) {
      const result = analyze(source);
      strict.ok(
        result.diagnostics.some((d) => d.severity === "error"),
        source,
      );
      strict.equal(result.semantics.operation.value, "unknown");
    }
  });
  await it("reports original UTF-16 diagnostic locations", () => {
    const source = "/*😀*/ SELECT missing FROM dbo.orders";
    const diagnostic = analyze(source).diagnostics[0]!;
    strict.equal(source.slice(diagnostic.range.start, diagnostic.range.end), "missing");
  });
  await it("does not claim repeated relation sources preserve SELECT star width", () => {
    for (const source of [
      "SELECT * FROM dbo.orders o JOIN (SELECT order_id FROM dbo.items) i ON i.order_id=o.id",
      "SELECT id FROM dbo.orders WHERE id IN (1,2)",
    ]) {
      const start = source.indexOf(source.includes(" JOIN ") ? "JOIN" : "1,2");
      const end = source.includes(" JOIN ") ? source.length : start + 3;
      const result = grammar.analyze(source, snapshot, undefined, { repeatedFragmentRanges: [{ start, end }] });
      strict.deepEqual(result.diagnostics, []);
      strict.equal(result.repeatedResultShapeStable === true, !source.includes(" JOIN "));
    }
  });
});
