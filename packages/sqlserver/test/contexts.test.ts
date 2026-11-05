import { upgradeSchemaSnapshotV1 } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import {
  sqlServerCollationCodePage,
  sqlServerEncodedTextLength,
  validateSqlServerCollationName,
} from "../src/collation.js";
import { parseStatement } from "../src/parser/index.js";
import { analyzeSqlServerSemantics } from "../src/semantics.js";
import { grammar, snapshot } from "./helpers/maturity-corpus.js";

await describe("SQL Server scalar, source and syntax boundaries", async () => {
  await it("retains supported native scalar rules through real expression contexts", () => {
    const expressions = [
      ["1e2", "float(53)"],
      ["2147483648", "decimal(10,0)"],
      ["0.125", "decimal(3,3)"],
      ["@@IDENTITY", "decimal(38,0)"],
      ["@@ROWCOUNT", "int"],
      ["-quantity", "int"],
      ["code+N'!'", "nvarchar(41) COLLATE Latin1_General_100_CI_AS"],
      ["amount-adjustment", "decimal(14,3)"],
      ["amount%adjustment", "decimal(9,3)"],
      ["CASE quantity WHEN 1 THEN id ELSE parent_id END", "bigint"],
      ["IIF(quantity>0,id,parent_id)", "bigint"],
      ["CHOOSE(quantity,id,parent_id)", "bigint"],
      ["GREATEST(quantity,tiny)", "int"],
      ["LEAST(quantity,optional_qty)", "int"],
      ["SCOPE_IDENTITY()", "decimal(38,0)"],
      ["SERVERPROPERTY('ProductVersion')", "sql_variant"],
      ["NTILE(2) OVER (ORDER BY id)", "bigint"],
      ["STDEV(quantity)", "float(53)"],
      ["NEWID()", "uniqueidentifier"],
      ["HASHBYTES('SHA2_256',code)", "varbinary(max)"],
      ["CONCAT(@__typed_sql_1,code)", "nvarchar(max) COLLATE Latin1_General_100_CI_AS"],
      ["CONCAT_WS(',',code,document)", "nvarchar(max) COLLATE Latin1_General_100_CI_AS"],
      ["DATEFROMPARTS(2024,2,29)", "date"],
      ["GETDATE()", "datetime"],
      ["SYSDATETIME()", "datetime2(7)"],
      ["SYSDATETIMEOFFSET()", "datetimeoffset(7)"],
      ["DATETRUNC(day,CAST('2024-01-01' AS date))", "date"],
      ["DATETRUNC(day,'2024-01-01')", "datetime2(7)"],
      ["DATE_BUCKET(day,1,CAST('2024-01-01' AS date))", "date"],
      ["DATEPART(day,@__typed_sql_1)", "int"],
      ["DATENAME(month,@__typed_sql_1)", "nvarchar(4000)"],
      ["DATEDIFF(day,@__typed_sql_1,@__typed_sql_2)", "int"],
      ["DATEDIFF_BIG(day,@__typed_sql_1,@__typed_sql_2)", "bigint"],
      ["JSON_VALUE(document,'$.id')", "nvarchar(4000)"],
      ["JSON_MODIFY(document,'$.id',id)", "nvarchar(max)"],
      ["SUM(tiny)", "int"],
      ["SUM(CAST(amount AS smallmoney))", "money"],
      ["AVG(CAST(amount AS real))", "float(53)"],
      ["ISNULL(@__typed_sql_1,quantity)", "int"],
      ["NULLIF(quantity,@__typed_sql_1)", "int"],
      ["CONVERT(nvarchar(40),id,0)", "nvarchar(40) COLLATE Latin1_General_100_CI_AS"],
      ["TRY_CONVERT(int,code)", "int"],
      ["TRY_CAST(code AS bigint)", "bigint"],
    ] as const;
    for (const [expression, databaseType] of expressions) {
      const source = `SELECT ${expression} AS value FROM dbo.widgets`,
        result = grammar.analyze(source, snapshot);
      strict.deepEqual(result.diagnostics, [], source);
      strict.equal(result.columns[0]?.databaseType, databaseType, source);
      strict.equal(result.columns[0]?.range.start, 7);
    }
    const split = grammar.analyze("SELECT s.value,s.ordinal FROM STRING_SPLIT(@__typed_sql_1,N',',1) AS s", snapshot);
    strict.deepEqual(split.diagnostics, []);
    strict.deepEqual(
      split.columns.map((c) => [c.name, c.databaseType, c.nullable]),
      [
        ["value", "nvarchar(max)", true],
        ["ordinal", "bigint", false],
      ],
    );
    strict.equal(split.parameters[0]?.databaseType, "nvarchar(max)");
  });
  await it("rejects invalid native contexts with bounded source diagnostics", () => {
    for (const source of [
      "SELECT 1e999 AS value",
      "SELECT 123456789012345678901234567890123456789 AS value",
      "SELECT 1.123456789012345678901234567890123456789 AS value",
      "SELECT -code AS value FROM dbo.widgets",
      "SELECT id+payload AS value FROM dbo.widgets",
      "SELECT id FROM dbo.widgets WHERE payload=payload",
      "SELECT (SELECT id,quantity FROM dbo.widgets) AS value",
      "SELECT id FROM dbo.widgets WHERE id IN (SELECT id,quantity FROM dbo.widgets)",
      "SELECT missing.* FROM dbo.widgets",
      "SELECT *",
      "SELECT TOP(2) WITH TIES id FROM dbo.widgets",
      "SELECT id FROM dbo.widgets OFFSET 1 ROWS",
      "SELECT id FROM dbo.widgets FETCH NEXT 1 ROWS ONLY",
      "SELECT ABS(code) AS value FROM dbo.widgets",
      "SELECT FLOOR(code) AS value FROM dbo.widgets",
      "SELECT SUM(code) AS value FROM dbo.widgets",
      "SELECT DATEADD(nonsense,1,GETDATE()) AS value",
      "SELECT DATE_BUCKET(day,1,'2024-01-01') AS value",
      "SELECT JSON_OBJECT('one':id,'one':quantity) AS value FROM dbo.widgets",
      "SELECT * FROM STRING_SPLIT(N'one') s",
      "SELECT * FROM STRING_SPLIT(N'one',N',',quantity) s",
      "SELECT * FROM STRING_SPLIT(N'one',N',',2) s",
      "SELECT * FROM OPENJSON(N'[]',N'$',N'$') j",
      "SELECT * FROM (SELECT id FROM dbo.widgets) x(a,b)",
      "SELECT * FROM OPENJSON(N'[]') x(a,b)",
      "WITH a(x,y) AS (SELECT id FROM dbo.widgets) SELECT x FROM a",
      "WITH a AS (SELECT id FROM dbo.widgets),a AS (SELECT id FROM dbo.widgets) SELECT id FROM a",
      "WITH a AS (SELECT id FROM a) SELECT id FROM a",
      "WITH a(x) AS (SELECT CAST(1 AS int) UNION ALL SELECT x FROM a UNION ALL SELECT 2) SELECT x FROM a",
      "WITH a(x) AS (SELECT 1 UNION ALL SELECT TOP(1) x FROM a) SELECT x FROM a",
      "WITH a(x) AS (SELECT 1 UNION ALL SELECT SUM(x) FROM a) SELECT x FROM a",
      "INSERT INTO dbo.widgets(missing) VALUES(1)",
      "INSERT INTO dbo.widgets(id,id) VALUES(1,2)",
      "INSERT INTO dbo.widgets(id) VALUES(1,2)",
      "UPDATE dbo.widgets SET missing=1",
      "DELETE FROM dbo.widgets OUTPUT deleted.id INTO dbo.children(id,parent_id)",
      "DELETE FROM dbo.widgets OUTPUT deleted.id INTO dbo.children(missing)",
      "DELETE FROM dbo.widgets OUTPUT deleted.id,deleted.id INTO dbo.children(id,id)",
      "SELECT id FROM one.two.three.four.five",
      "SELECT CAST(id AS decimal(99,2)) AS value FROM dbo.widgets",
      "SELECT id FROM dbo.widgets WITH(INDEX(foo))",
      "SELECT id FROM dbo.widgets WHERE id IN ()",
      "SELECT JSON_OBJECT('id' id) AS value FROM dbo.widgets",
      "SELECT CASE WHEN id=1 THEN 1 AS value FROM dbo.widgets",
    ]) {
      const result = grammar.analyze(source, snapshot),
        errors = result.diagnostics.filter((d) => d.severity === "error");
      strict.ok(errors.length > 0, source);
      strict.equal(result.semantics?.operation.value, "unknown", source);
      for (const error of errors) strict.ok(error.range.start >= 0 && error.range.end <= source.length, source);
    }
  });
  await it("uses catalog writability, hidden columns and trigger evidence in DML contexts", () => {
    const upgraded = upgradeSchemaSnapshotV1(snapshot),
      table = upgraded.relations.widgets!;
    const columns = Object.fromEntries(
      Object.entries(table.columns).map(([name, column]) => [
        name,
        {
          ...column,
          generated: "none" as const,
          ...(name === "id"
            ? { identity: "always" as const, insertable: false as const, updatable: false as const }
            : {}),
          ...(name === "payload" ? { classification: "hidden" as const } : {}),
        },
      ]),
    );
    const schema = {
      ...upgraded,
      dialect: "sqlserver" as const,
      relations: { ...upgraded.relations, widgets: { ...table, columns, capabilities: { outputWithoutInto: false } } },
    };
    for (const source of [
      "INSERT INTO dbo.widgets(id) VALUES(1)",
      "UPDATE dbo.widgets SET id=1",
      "DELETE FROM dbo.widgets OUTPUT deleted.id",
      "INSERT INTO dbo.widgets(quantity) SELECT id,quantity FROM dbo.widgets",
    ]) {
      const result = grammar.analyze(source, schema);
      strict.ok(
        result.diagnostics.some((d) => d.severity === "error"),
        source,
      );
    }
    const projected = grammar.analyze("SELECT * FROM dbo.widgets", schema);
    strict.deepEqual(projected.diagnostics, []);
    strict.equal(
      projected.columns.some((column) => column.name === "payload"),
      false,
    );
    const implicit = grammar.analyze("INSERT INTO dbo.widgets DEFAULT VALUES", schema);
    strict.deepEqual(implicit.diagnostics, []);
    strict.equal(implicit.resultKind, "command");
    const into = grammar.analyze(
      "DELETE TOP(1) FROM dbo.widgets OUTPUT deleted.id,deleted.id,deleted.amount INTO dbo.children(id,parent_id,amount) WHERE id=1",
      snapshot,
    );
    strict.deepEqual(into.diagnostics, []);
    strict.equal(into.resultKind, "command");
  });
  await it("keeps relation qualification, collation conflicts and unsupported native identities conservative", () => {
    const schema = {
      ...snapshot,
      server: { ...snapshot.server, settings: { ...snapshot.server.settings, databaseName: "commerce" } },
    };
    const current = grammar.analyze("SELECT commerce.dbo.widgets.id FROM commerce.dbo.widgets", schema);
    strict.deepEqual(current.diagnostics, []);
    strict.equal(current.columns[0]?.tsType, "bigint");
    for (const source of ["SELECT id FROM other.dbo.widgets", "SELECT id FROM linked.commerce.dbo.widgets"])
      strict.ok(grammar.analyze(source, schema).diagnostics.some((d) => d.code === "TSQ108"));
    const columns = {
      ...snapshot.tables.widgets.columns,
      code2: {
        name: "code2",
        databaseType: "varchar(20) COLLATE Latin1_General_100_CS_AS",
        tsType: "string",
        nullable: false,
      },
      opaque: { name: "opaque", databaseType: "custom.geometry", tsType: "unknown", nullable: true },
    };
    const conflict = { ...snapshot, tables: { ...snapshot.tables, widgets: { ...snapshot.tables.widgets, columns } } };
    for (const expression of ["code+code2", "COALESCE(code,code2)", "CAST(opaque AS int)", "COALESCE(opaque,id)"])
      strict.ok(
        grammar
          .analyze(`SELECT ${expression} AS value FROM dbo.widgets`, conflict)
          .diagnostics.some((d) => d.code === "TSQ201"),
        expression,
      );
    const ambiguous = { ...snapshot, tables: { ...snapshot.tables, duplicate: snapshot.tables.widgets } };
    strict.ok(grammar.analyze("SELECT id FROM dbo.widgets", ambiguous).diagnostics.some((d) => d.code === "TSQ102"));
  });
  await it("keeps table hints, temporal sources and NULL conditions in their native semantic scopes", () => {
    for (const [hint, locking] of [
      ["NOLOCK", "none"],
      ["UPDLOCK", "row"],
      ["TABLOCK", "table"],
      ["TABLOCKX", "table"],
    ] as const) {
      const result = grammar.analyze(
        `SELECT id FROM dbo.widgets WITH(${hint}) WHERE NOT(quantity IS NULL) AND quantity NOT IN (1,2) OR quantity BETWEEN 3 AND 4`,
        snapshot,
      );
      strict.deepEqual(result.diagnostics, []);
      strict.equal(result.semantics?.locking.value, locking);
    }
    const upgraded = upgradeSchemaSnapshotV1(snapshot);
    const temporalSchema = {
      ...upgraded,
      dialect: "sqlserver" as const,
      relations: {
        ...upgraded.relations,
        widgets: { ...upgraded.relations.widgets!, extension: { version: "1", attributes: { temporalType: 2 } } },
      },
    };
    const temporal = grammar.analyze("SELECT id FROM dbo.widgets FOR SYSTEM_TIME AS OF @__typed_sql_1", temporalSchema);
    strict.ok(
      grammar
        .analyze("SELECT id FROM dbo.widgets FOR SYSTEM_TIME AS OF @__typed_sql_1", snapshot)
        .diagnostics.some((d) => d.code === "TSQ203"),
    );
    strict.deepEqual(temporal.diagnostics, []);
    strict.equal(temporal.parameters[0]?.databaseType, "datetime2(7)");
    for (const source of [
      "SELECT DISTINCT id FROM dbo.widgets ORDER BY id+1",
      "SELECT DISTINCT w.* FROM dbo.widgets w ORDER BY w.id",
      "SELECT id FROM dbo.widgets WHERE @__typed_sql_1 BETWEEN 1 AND 2",
      "SELECT id FROM dbo.widgets WHERE @__typed_sql_1 IN (1,2)",
    ]) {
      const result = grammar.analyze(source, snapshot);
      strict.deepEqual(result.diagnostics, [], source);
    }
  });
  await it("separates native code page evidence from syntactically valid collation names", () => {
    strict.equal(sqlServerCollationCodePage("Latin1_General_100_BIN2"), 1252);
    strict.equal(sqlServerCollationCodePage("Latin1_General_100_BIN2_UTF8"), 65001);
    strict.equal(sqlServerCollationCodePage("Japanese_Bushu_Kakusu_140_CI_AS"), undefined);
    strict.equal(validateSqlServerCollationName("Japanese_Bushu_Kakusu_140_CI_AS"), "Japanese_Bushu_Kakusu_140_CI_AS");
    strict.throws(() => validateSqlServerCollationName("Latin1_General_CI_AS; DROP TABLE x"), /identity/);
    strict.equal(sqlServerEncodedTextLength("ASCII\0", "Japanese_Bushu_Kakusu_140_CI_AS"), 6);
    strict.throws(() => sqlServerEncodedTextLength("漢", "Japanese_Bushu_Kakusu_140_CI_AS"), /collation evidence/);
  });
  await it("keeps syntax-only dependency evidence and session affinity distinct from resolved catalog facts", () => {
    const syntactic = analyzeSqlServerSemantics(parseStatement("SELECT id FROM dbo.unknown_table"));
    strict.equal(syntactic.dependencies.find((dependency) => dependency.kind === "relation")?.certainty, "syntactic");
    const temporary = {
      ...snapshot,
      tables: { ...snapshot.tables, temporary: { ...snapshot.tables.widgets, name: "#widgets" } },
    };
    const session = grammar.analyze("SELECT id FROM #widgets", temporary);
    strict.deepEqual(session.diagnostics, []);
    strict.equal(session.semantics?.connectionAffinity.value, "session");
    const lock = grammar.analyze(
      "SELECT w.id FROM dbo.widgets w WITH(TABLOCK) JOIN dbo.children c WITH(UPDLOCK) ON w.id=c.parent_id",
      snapshot,
    );
    strict.deepEqual(lock.diagnostics, []);
    strict.equal(lock.semantics?.locking.value, "table");
    const sorted = grammar.analyze("SELECT TOP(1) WITH TIES quantity FROM dbo.widgets ORDER BY quantity", snapshot);
    strict.deepEqual(sorted.diagnostics, []);
    strict.equal(sorted.semantics?.cardinality.maximum, "many");
    const collation = {
      ...snapshot,
      server: { ...snapshot.server, settings: { ...snapshot.server.settings, collation: "Latin1_General_100_CI_AI" } },
    };
    strict.deepEqual(grammar.analyze("SELECT QUANTITY FROM dbo.WIDGETS", collation).diagnostics, []);
  });
});
