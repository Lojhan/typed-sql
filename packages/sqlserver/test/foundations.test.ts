import { describe, it, strict } from "poku";
import { parseSqlServerNativeType, requireSqlServerNativeType, validateSqlServerDecimal } from "../src/native-types.js";
import { parseStatement, SqlServerParseError, tokenize } from "../src/parser/index.js";
import { sqlServerVersionSupport } from "../src/support.js";
import { mapSqlServerType } from "../src/type-policy.js";

await describe("SQL Server grammar-owned lexical and native foundations", async () => {
  await it("distinguishes SQL-file named bindings from native JSON key delimiters", () => {
    const source =
      "SELECT JSON_OBJECT('id':id,'dynamic': :value,name:quantity,CONCAT('k','ey'): :other,:key: :mapped) AS doc FROM t WHERE id=:id OR parent_id=:id";
    const tokens = tokenize(source, { sqlFileParameters: true });
    strict.deepEqual(
      tokens.filter((token) => token.kind === "parameter").map((token) => token.text),
      [":value", ":other", ":key", ":mapped", ":id", ":id"],
    );
    strict.equal(tokens.filter((token) => token.kind === "punctuation" && token.value === ":").length, 5);
    strict.deepEqual(
      tokenize("SELECT JSON_OBJECT('id':id) AS doc").filter((token) => token.kind === "parameter"),
      [],
    );
  });
  await it("parses representative T-SQL structures without another grammar's parser", () => {
    for (const source of [
      "SELECT TOP (10) WITH TIES o.id, ISNULL(o.name,N'none') AS name FROM dbo.orders AS o ORDER BY o.id",
      "WITH c(id) AS (SELECT id FROM dbo.orders) SELECT c.id FROM c WHERE c.id=@id ORDER BY id OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY",
      "SELECT o.id,x.total FROM dbo.orders o OUTER APPLY (SELECT SUM(i.amount) AS total FROM dbo.items i WHERE i.order_id=o.id) x",
      "SELECT id, ROW_NUMBER() OVER(PARTITION BY status ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS n FROM dbo.orders",
      "INSERT INTO dbo.orders(id,name) OUTPUT inserted.id,inserted.name VALUES(@id,N'Ada'),(@other,N'Grace')",
      "UPDATE o SET name=@name OUTPUT inserted.id,deleted.name AS previous FROM dbo.orders o WHERE o.id=@id",
      "DELETE FROM dbo.orders OUTPUT deleted.id WHERE id=@id",
      "SELECT CAST(@id AS bigint) AS id, TRY_CONVERT(decimal(38,10),@amount) AS amount",
      "SELECT x.id FROM OPENJSON(@document) WITH (id bigint '$.id',nested nvarchar(max) '$.data' AS JSON) AS x",
      "SELECT CASE WHEN id BETWEEN 1 AND 2 THEN N'yes' ELSE N'no' END AS label FROM dbo.orders",
      "SELECT id FROM dbo.orders UNION ALL SELECT id FROM dbo.archived ORDER BY id",
    ])
      strict.ok(parseStatement(source), source);
  });
  await it("preserves UTF-16 offsets, nested comments, Unicode strings, brackets and native binds", () => {
    const source = "/*😀 /*nested*/ */\nSELECT [a]]b], N'😀''x', @id, @id, @@ROWCOUNT, 0x00ff";
    const tokens = tokenize(source);
    strict.deepEqual(
      tokens.filter((t) => t.kind === "parameter").map((t) => t.value),
      ["1", "1"],
    );
    strict.equal(tokens.find((t) => t.kind === "identifier")?.value, "a]b");
    strict.equal(tokens.find((t) => t.kind === "string")?.value, "😀'x");
    for (const token of tokens) strict.equal(source.slice(token.range.start, token.range.end), token.text);
    strict.equal(tokens.find((t) => t.value === "SELECT")?.range.line, 2);
  });
  await it("fails closed on unsupported statements, batches and invalid syntax", () => {
    for (const source of [
      "SELECT 1 AS n; DROP TABLE dbo.orders",
      "SELECT id FROM dbo.orders LIMIT 1",
      "EXEC(@sql)",
      "DECLARE @x int; SELECT @x AS n",
      "SELECT TOP 1 WITH TIES id FROM dbo.orders",
      "SELECT id FROM dbo.orders OFFSET 1 ROWS",
      "SELECT id FROM dbo.orders OPTION(RECOMPILE)",
      "SELECT 'unterminated",
      "SELECT [unterminated",
      "SELECT 0xgg AS bytes",
    ]) {
      strict.throws(() => parseStatement(source), SqlServerParseError, source);
    }
    strict.throws(() => tokenize("x".repeat(11), { maxSqlLength: 10 }), /limit/);
    strict.throws(() => tokenize("a b c", { maxTokens: 2 }), /limit/);
  });
  await it("canonicalizes only allowlisted bounded native type syntax", () => {
    strict.equal(parseSqlServerNativeType(" NUMERIC(38, 10) ")?.text, "decimal(38,10)");
    strict.equal(parseSqlServerNativeType("nvarchar(MAX)")?.text, "nvarchar(max)");
    strict.equal(parseSqlServerNativeType("timestamp")?.text, "rowversion");
    for (const source of [
      "nvarchar(4001)",
      "varchar(8001)",
      "char(max)",
      "decimal(39,0)",
      "decimal(4,5)",
      "time(8)",
      "int);DROP TABLE t;--",
      "float(0)",
      "int(5)",
      "not_a_builtin",
    ]) {
      strict.equal(parseSqlServerNativeType(source), undefined, source);
    }
    strict.equal(mapSqlServerType("rowversion"), "Uint8Array");
    strict.equal(mapSqlServerType("datetime2(7)"), "string");
    strict.equal(mapSqlServerType("decimal(38,10)"), "string");
    strict.equal(mapSqlServerType("bigint"), "bigint");
  });
  await it("validates exact decimal bounds without a floating-point intermediate", () => {
    const type = requireSqlServerNativeType("decimal(38,10)");
    strict.equal(
      validateSqlServerDecimal("-1234567890123456789012345678.1234567890", type),
      "-1234567890123456789012345678.1234567890",
    );
    strict.equal(validateSqlServerDecimal("-0.000", requireSqlServerNativeType("decimal(4,2)")), "0.00");
    strict.throws(() => validateSqlServerDecimal("0.001", requireSqlServerNativeType("decimal(4,2)")), /rounding/);
    strict.throws(() => validateSqlServerDecimal("100", requireSqlServerNativeType("decimal(4,2)")), /precision/);
    strict.throws(() => validateSqlServerDecimal("922337203685477.5808", requireSqlServerNativeType("money")), /range/);
  });
  await it("keeps engine build identity separate from legal compatibility levels", () => {
    strict.equal(sqlServerVersionSupport("17.0.5035.5", 170), "supported");
    strict.equal(sqlServerVersionSupport("14.0.3560.2", 170), "conservative");
    strict.equal(sqlServerVersionSupport("13.0.0.0", 130), "unsupported");
    strict.equal(sqlServerVersionSupport("18.0.1.1", 180), "conservative");
    strict.equal(sqlServerVersionSupport("17.0.5035.5-preview", 170), "conservative");
  });
});
