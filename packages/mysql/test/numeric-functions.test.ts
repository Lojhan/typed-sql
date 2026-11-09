import { describe, it, strict } from "poku";
import { mysqlNumericCases } from "../../../test/helpers/mysql-numeric-cases.js";
import { resolveMySqlStatement } from "../src/compatibility-resolver.js";
import { mySqlNumericLiteralType } from "../src/numeric-functions.js";
import { parseStatement } from "../src/parser/index.js";
import { MYSQL_SUPPORT_POLICY } from "../src/support.js";
import { defaultMySqlTypePolicy, isKnownMySqlType, mapMySqlType } from "../src/type-policy.js";

const schema = {
  formatVersion: 1,
  dialect: "mysql",
  version: MYSQL_SUPPORT_POLICY.stable[0].matrixVersion,
  tables: {},
  functions: {},
} as const;
const resolve = (expression: string) => resolveMySqlStatement(parseStatement(`SELECT ${expression} AS value`), schema);

await describe("MySQL numeric result families", async () => {
  await it("uses catalog argument bounds for unary, optional and binary builtin families", () => {
    for (const target of [...MYSQL_SUPPORT_POLICY.stable, MYSQL_SUPPORT_POLICY.canary]) {
      for (const expression of [
        "ATAN(1)",
        "ATAN(1,2)",
        "ATAN2(1)",
        "ATAN2(1,2)",
        "LOG(2)",
        "LOG(2,8)",
        "POW(2,3)",
        "LENGTH('x')",
        "LOCATE('x','text')",
      ])
        strict.deepEqual(
          resolveMySqlStatement(parseStatement(`SELECT ${expression} AS value`), {
            ...schema,
            version: target.matrixVersion,
          }).diagnostics,
          [],
          expression,
        );
      for (const expression of [
        "ATAN()",
        "ATAN(1,2,3)",
        "ATAN2()",
        "ATAN2(1,2,3)",
        "LOG()",
        "LOG(1,2,3)",
        "LN(1,2)",
        "POW(1)",
        "LENGTH('x','y')",
        "LOCATE('x')",
      ]) {
        const result = resolveMySqlStatement(parseStatement(`SELECT ${expression} AS value`), {
          ...schema,
          version: target.matrixVersion,
        });
        strict.equal(result.diagnostics.length, 1, expression);
        strict.equal(result.diagnostics[0]?.code, "TSQ227", expression);
        strict.equal(result.diagnostics[0]?.range.start, 7, expression);
        strict.equal(result.columns[0]?.tsType, "unknown", expression);
      }
    }
  });

  await it("preserves native numeric categories, domain nullability and source spans in every catalog band", () => {
    for (const target of [...MYSQL_SUPPORT_POLICY.stable, MYSQL_SUPPORT_POLICY.canary]) {
      for (const test of mysqlNumericCases) {
        const sql = `SELECT ${test.expression} AS value`,
          result = resolveMySqlStatement(parseStatement(sql), { ...schema, version: target.matrixVersion });
        strict.deepEqual(result.diagnostics, [], `${target.series}: ${sql}`);
        strict.deepEqual(result.parameters, []);
        strict.equal(result.columns.length, 1);
        const column = result.columns[0]!;
        strict.equal(column.tsType, test.type, sql);
        strict.equal(column.databaseType, test.databaseType, sql);
        strict.equal(column.nullable, test.nullable, sql);
        strict.ok(column.range.start >= 0 && column.range.end <= sql.length && column.range.end > column.range.start);
      }
    }
  });

  await it("keeps decimal spelling and dimensions through literal parsing and signed casts", () => {
    for (const [expression, databaseType, type] of [
      ["1.00", "decimal(3,2)", "string"],
      [".25", "decimal(2,2)", "string"],
      ["1.", "decimal(1,0)", "string"],
      ["0001.20", "decimal(4,2)", "string"],
      ["1e0", "double", "number"],
      ["2147483648", "bigint", "bigint"],
      ["9223372036854775808", "bigint unsigned", "bigint"],
      ["18446744073709551616", "decimal(20,0)", "string"],
      ["CAST(1 AS SIGNED INTEGER)", "bigint", "bigint"],
      ["CAST(1 AS UNSIGNED INTEGER)", "bigint unsigned", "bigint"],
      ["CAST(1 AS DECIMAL)", "decimal(10,0)", "string"],
      ["CAST(1 AS DECIMAL(9))", "decimal(9,0)", "string"],
    ]) {
      const result = resolve(expression!);
      strict.deepEqual(result.diagnostics, [], expression);
      strict.equal(result.columns[0]?.databaseType, databaseType, expression);
      strict.equal(result.columns[0]?.tsType, type, expression);
    }
    for (const input of ["invalid", "1e999", "9".repeat(66), `0.${"1".repeat(31)}`])
      strict.equal(mySqlNumericLiteralType(input), undefined);
    strict.equal(mySqlNumericLiteralType("0000"), "int");
    strict.ok(resolve("1e999").diagnostics.some(({ code }) => code === "TSQ401"));
    for (const type of ["decimal(0)", "decimal(66,1)", "decimal(9,10)", "decimal(65,31)", "decimal(foo)"]) {
      strict.equal(isKnownMySqlType(type, schema), false);
      strict.equal(mapMySqlType(type, defaultMySqlTypePolicy, schema), "unknown");
      strict.ok(resolve(`CAST(1 AS ${type})`).diagnostics.some(({ code }) => code === "TSQ106"));
    }
  });

  await it("uses decimal precision boundaries and the configured integer/decimal representation", () => {
    for (const [expression, type, databaseType, nullable] of [
      ["ABS(2)", "bigint", "bigint", false],
      ["ABS(2e0)", "number", "double", false],
      ["ABS(NULL)", "number", "double", true],
      ["ABS('2')", "number", "double", false],
      ["FLOOR(1.25)", "bigint", "bigint", false],
      ["CEIL(CAST(1.25 AS DECIMAL(20,2)))", "string", "decimal(19,0)", false],
      ["FLOOR(CAST(1.25 AS DECIMAL(19,2)))", "bigint", "bigint", false],
      ["ROUND(1.234)", "string", "decimal(2,0)", false],
      ["ROUND(1.234,-1)", "string", "decimal(2,0)", false],
      ["ROUND(1.234,9)", "string", "decimal(4,3)", false],
      ["ROUND(1.234,TRUE)", "string", "decimal(3,1)", false],
      ["ROUND(1.234,FALSE)", "string", "decimal(2,0)", false],
      ["ROUND(1.234,NULL)", "string", "decimal(2,0)", true],
      ["ROUND(1.234,'2')", "string", "decimal", false],
      ["ROUND(1.234,0.5)", "string", "decimal", false],
      ["ROUND(CAST(1 AS UNSIGNED),1)", "bigint", "bigint unsigned", false],
      ["ROUND(1.234,+1)", "string", "decimal(3,1)", false],
      ["RAND()", "number", "double", false],
      ["RAND(NULL)", "number", "double", true],
    ] as const) {
      const result = resolve(expression);
      strict.deepEqual(result.diagnostics, [], expression);
      strict.equal(result.columns[0]?.tsType, type, expression);
      strict.equal(result.columns[0]?.databaseType, databaseType, expression);
      strict.equal(result.columns[0]?.nullable, nullable, expression);
    }
    const overridden = resolveMySqlStatement(parseStatement("SELECT ABS(1), ROUND(1.25,1)"), schema, {
      typePolicy: { ...defaultMySqlTypePolicy, bigint: "string", decimal: "Decimal" },
    });
    strict.deepEqual(overridden.diagnostics, []);
    strict.deepEqual(
      overridden.columns.map(({ tsType }) => tsType),
      ["string", "Decimal"],
    );
    for (const expression of ["SIN()", "SIN(1,2)", "LENGTH(1,2)", "ABS()", "ROUND(1,2,3)"])
      strict.ok(
        resolve(expression).diagnostics.some(({ code }) => code === "TSQ227"),
        expression,
      );
    for (const expression of ["ABS(?)", "ABS(CAST(NULL AS VECTOR))", "FLOOR(1.25 + 2.3)"])
      strict.ok(
        resolve(expression).diagnostics.some(({ code }) => code === "TSQ401"),
        expression,
      );
  });
});
