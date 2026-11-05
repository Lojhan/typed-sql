import { assertFragmentListConformance } from "@typed-sql/conformance";
import { defineConformanceProbe, runStaticConformanceProbe } from "@typed-sql/conformance/v2";
import { renderQuery, type SourceRange } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { sql, sqlServerRenderer } from "../src/query.js";
import { grammar, MATURITY_CASES, type MaturityCase, snapshot, target } from "./helpers/maturity-corpus.js";

function range(source: string, text: string, last = false): SourceRange {
  const start = last ? source.lastIndexOf(text) : source.indexOf(text);
  if (start < 0) strict.fail(`Missing oracle projection ${text}`);
  const before = source.slice(0, start);
  return { start, end: start + text.length, line: before.split("\n").length, column: start - before.lastIndexOf("\n") };
}
const projections: Readonly<Record<string, readonly string[]>> = {
  "left-join": ["w.id", "c.amount"],
  "full-join": ["w.id AS widget_id", "c.id AS child_id"],
  "cross-apply-correlated": ["w.id", "a.amount"],
  "outer-apply-correlated": ["w.id", "a.amount"],
  "window-rank": ["id", "ROW_NUMBER() OVER (PARTITION BY active ORDER BY quantity DESC) AS rank"],
  "insert-output": ["inserted.id"],
  "delete-output": ["deleted.id"],
  "update-output-old-new": ["deleted.quantity AS old_quantity", "inserted.quantity AS new_quantity"],
  "known-scalar-functions": ["LEN(code) AS length", "DATALENGTH(code) AS bytes", "ABS(quantity) AS magnitude"],
};
function expectedRows(test: MaturityCase) {
  const texts =
    projections[test.id] ??
    (test.rows[0]?.name === "value"
      ? [test.sql.slice("SELECT ".length, test.sql.lastIndexOf(" AS value") + " AS value".length)]
      : test.rows.map((row) => row.name));
  return test.rows.map((row, index) => ({
    ...row,
    range: range(test.sql, texts[index]!, test.id === "cte-column-list"),
  }));
}
await describe("SQL Server vendor-backed conformance-v2 maturity corpus", async () => {
  for (const test of MATURITY_CASES) {
    await it(`${test.feature}: ${test.id}`, () => {
      strict.ok(test.vendor.startsWith("https://learn.microsoft.com/"));
      const rowType = `{ ${test.rows.map((c) => `${JSON.stringify(c.name)}: ${c.tsType}${c.nullable ? " | null" : ""};`).join(" ")} }`;
      const probe = defineConformanceProbe({
        version: 2,
        id: `sqlserver.maturity.${test.id}`,
        featureId: `sqlserver.${test.feature}`,
        grammar: "sqlserver",
        targets: [target],
        source: test.sql,
        schemaFixture: "packages/sqlserver/test/helpers/maturity-corpus.ts",
        compilerSource: `import { sql } from "@typed-sql/sqlserver";\nexport const query = sql\`${test.sql}\`;`,
        live: { prepare: true, execute: false, allowMutation: test.operation === "write" },
        expected: [
          {
            target: { databaseVersion: target.databaseVersion },
            support: "exact",
            rows: expectedRows(test),
            parameters: [],
            diagnostics: [],
            resultKind: "rows",
            compiled: { rowType, parameterType: "readonly []" },
          },
        ],
      });
      const report = runStaticConformanceProbe(probe, target, {
        dialect: grammar,
        snapshot,
        renderer: sqlServerRenderer,
      });
      strict.deepEqual(
        report.layers.filter((layer) => layer.status === "fail"),
        [],
        report.status === "fail" ? JSON.stringify(report, null, 2) : undefined,
      );
      for (const required of ["resolve", "compile"])
        strict.equal(report.layers.find((layer) => layer.layer === required)?.status, "pass");
      const analysis = grammar.analyze(test.sql, snapshot);
      strict.equal(analysis.semantics?.operation.value, test.operation ?? "read");
      strict.equal(analysis.semantics?.cardinality.maximum, test.maximum ?? "many");
      strict.doesNotMatch(JSON.stringify(analysis.columns), /"tsType":"any"/u);
      for (const dependency of analysis.semantics?.dependencies ?? []) {
        strict.ok(dependency.range.start >= 0 && dependency.range.end <= test.sql.length);
      }
    });
  }
  await it("keeps ordered physical parameters and source spans when occurrence order differs from index order", () => {
    const source =
      "-- 😀\nSELECT id,code FROM dbo.widgets WHERE code=@__typed_sql_3 AND id=@__typed_sql_1 AND quantity=@__typed_sql_2";
    const result = grammar.analyze(source, snapshot);
    strict.deepEqual(result.diagnostics, []);
    strict.deepEqual(
      result.parameters.map((p) => [p.index, p.tsType, p.databaseType, p.nullable]),
      [
        [1, "bigint", "bigint", true],
        [2, "number", "int", true],
        [3, "string", "nvarchar(40) COLLATE Latin1_General_100_CI_AS", true],
      ],
    );
    strict.deepEqual(
      result.columns.map((c) => c.range),
      [range(source, "id"), range(source, "code")],
    );
    strict.deepEqual(
      grammar.parameterOccurrences?.(source, snapshot).map((p) => [p.index, source.slice(p.range.start, p.range.end)]),
      [
        [3, "@__typed_sql_3"],
        [1, "@__typed_sql_1"],
        [2, "@__typed_sql_2"],
      ],
    );
  });
  await it("checks homogeneous repeated VALUES parameter targets and OUTPUT stability", () => {
    const source =
      "INSERT INTO dbo.children(id,parent_id,amount) OUTPUT inserted.id VALUES (@__typed_sql_1,@__typed_sql_2,@__typed_sql_3),(@__typed_sql_4,@__typed_sql_5,@__typed_sql_6)";
    const result = grammar.analyze(source, snapshot, undefined, {
      repeatedFragmentRanges: [{ start: source.indexOf("@__typed_sql_1"), end: source.length }],
    });
    strict.deepEqual(result.diagnostics, []);
    strict.equal(result.repeatedResultShapeStable, true);
    strict.deepEqual(
      result.parameters.map((p) => [p.index, p.tsType, p.databaseType]),
      [
        [1, "bigint", "bigint"],
        [2, "bigint", "bigint"],
        [3, "string", "decimal(12,2)"],
        [4, "bigint", "bigint"],
        [5, "bigint", "bigint"],
        [6, "string", "decimal(12,2)"],
      ],
    );
    strict.deepEqual(
      result.columns.map((c) => [c.name, c.tsType, c.nullable]),
      [["id", "bigint", false]],
    );
    strict.equal(result.semantics?.operation.value, "write");
  });
  await it("compiles mapped multi-row VALUES through the public conformance compiler boundary", () => {
    const source =
      "INSERT INTO dbo.children(id,parent_id,amount) OUTPUT inserted.id VALUES (@__typed_sql_1,@__typed_sql_2,@__typed_sql_3)";
    const compilerSource =
      'import { sql } from "@typed-sql/sqlserver"; export const insertMany = (rows: readonly {id: bigint; parentId: bigint; amount: string}[]) => sql`INSERT INTO dbo.children(id,parent_id,amount) OUTPUT inserted.id VALUES ${rows.map(row => sql.fragment`(${row.id},${row.parentId},${row.amount})`)}`;';
    const probe = defineConformanceProbe({
      version: 2,
      id: "sqlserver.maturity.mapped-values",
      featureId: "sqlserver.output",
      grammar: "sqlserver",
      targets: [target],
      source,
      schemaFixture: "packages/sqlserver/test/helpers/maturity-corpus.ts",
      compilerSource,
      expected: [
        {
          target: {},
          support: "exact",
          rows: [
            {
              name: "id",
              tsType: "bigint",
              nullable: false,
              databaseType: "bigint",
              range: range(source, "inserted.id"),
            },
          ],
          parameters: [
            {
              index: 1,
              tsType: "bigint",
              nullable: false,
              databaseType: "bigint",
              ...{ name: "id", runtimeType: "bigint" },
            },
            {
              index: 2,
              tsType: "bigint",
              nullable: false,
              databaseType: "bigint",
              ...{ name: "parent_id", runtimeType: "bigint" },
            },
            {
              index: 3,
              tsType: "string",
              nullable: false,
              databaseType: "decimal(12,2)",
              ...{ name: "amount", runtimeType: "string" },
            },
          ],
          diagnostics: [],
          compiled: { rowType: '{ "id": bigint; }', parameterType: "readonly unknown[]" },
        },
      ],
    });
    const report = runStaticConformanceProbe(probe, target, {
      dialect: grammar,
      snapshot,
      renderer: sqlServerRenderer,
    });
    const failures = report.layers.filter((layer) => layer.status === "fail");
    if (failures.length) strict.fail(JSON.stringify(failures));
    strict.equal(report.layers.find((layer) => layer.layer === "compile")?.status, "pass");
  });
  await it("renders multipart bracket identifiers and leaves SQL-looking values as ordered parameters", () => {
    const value = "x'); DELETE FROM dbo.widgets; --";
    const query = sql`SELECT ${sql.fragment`${sql.ident("dbo")}.${sql.ident("Order]History")}.${sql.ident("id")}`} WHERE code=${value} AND id=${1n}`;
    strict.deepEqual(renderQuery(query, sqlServerRenderer), {
      text: "SELECT [dbo].[Order]]History].[id] WHERE code=@__typed_sql_1 AND id=@__typed_sql_2",
      values: [value, 1n],
    });
    const source =
      "-- 😀 @hidden\nSELECT id FROM dbo.widgets WHERE id=@customer OR parent_id=@customer AND code='@ignored'";
    strict.deepEqual(
      grammar
        .parameterOccurrences?.(source, snapshot)
        .map((p) => ({ index: p.index, name: p.name, text: source.slice(p.range.start, p.range.end) })),
      [
        { index: 0, name: "customer", text: "@customer" },
        { index: 0, name: "customer", text: "@customer" },
      ],
    );
  });

  await it("proves mapped OUTPUT artifacts and ordered rendering for one, two and five rows", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: BigInt(i + 1), parentId: 9n, amount: `${i + 1}.00` }));
    const query = (count: number) =>
      sql`INSERT INTO dbo.children(id,parent_id,amount) OUTPUT inserted.id VALUES ${rows.slice(0, count).map((row) => sql.fragment`(${row.id}, ${row.parentId}, ${row.amount})`)}`;
    const text = (count: number) =>
      `INSERT INTO dbo.children(id,parent_id,amount) OUTPUT inserted.id VALUES ${Array.from({ length: count }, (_, i) => `(@__typed_sql_${i * 3 + 1}, @__typed_sql_${i * 3 + 2}, @__typed_sql_${i * 3 + 3})`).join(", ")}`;
    const compilerSource =
      'import { sql } from "@typed-sql/sqlserver"; declare const rows: readonly {id:bigint;parentId:bigint;amount:string}[]; sql`INSERT INTO dbo.children(id,parent_id,amount) OUTPUT inserted.id VALUES ${rows.map(row=>sql.fragment`(${row.id}, ${row.parentId}, ${row.amount})`)}`;';
    const report = assertFragmentListConformance({
      name: "sqlserver.maturity.output-mapped",
      dialect: grammar,
      renderer: sqlServerRenderer,
      snapshot,
      compilerSource,
      expectedRepresentativeSql: text(2),
      expectedRowType: '{ "id": bigint; }',
      expectedResultKind: "rows",
      expectedElementParameters: [
        { index: 1, tsType: "bigint", nullable: false, databaseType: "bigint" },
        { index: 2, tsType: "bigint", nullable: false, databaseType: "bigint" },
        { index: 3, tsType: "string", nullable: false, databaseType: "decimal(12,2)" },
      ],
      renderCases: ([1, 2, 5] as const).map((cardinality) => ({
        name: `${cardinality}-rows`,
        cardinality,
        query: query(cardinality),
        expectedText: text(cardinality),
        expectedValues: rows.slice(0, cardinality).flatMap((row) => [row.id, row.parentId, row.amount]),
      })),
    });
    strict.deepEqual(report.renderCardinalities, [1, 2, 5]);
  });
  await it("applies the same selected type policy to columns, casts, aggregates and ordered parameters", () => {
    const policy = {
      ...grammar.defaultTypePolicy,
      bigint: "string" as const,
      decimal: "number" as const,
      temporal: "Date" as const,
    };
    const source =
      "SELECT id,amount,TRY_CAST(code AS datetime2(7)) AS converted FROM dbo.widgets WHERE id=@__typed_sql_1 AND amount=@__typed_sql_2";
    const result = grammar.analyze(source, snapshot, policy);
    strict.deepEqual(result.diagnostics, []);
    strict.deepEqual(
      result.columns.map((c) => [c.name, c.tsType, c.nullable, c.databaseType]),
      [
        ["id", "string", false, "bigint"],
        ["amount", "number", false, "decimal(12,2)"],
        ["converted", "Date", true, "datetime2(7)"],
      ],
    );
    strict.deepEqual(
      result.parameters.map((p) => [p.index, p.tsType, p.databaseType]),
      [
        [1, "string", "bigint"],
        [2, "number", "decimal(12,2)"],
      ],
    );
    const aggregate = grammar.analyze(
      "SELECT COUNT_BIG(*) AS total,SUM(amount) AS amount FROM dbo.widgets",
      snapshot,
      policy,
    );
    strict.deepEqual(aggregate.diagnostics, []);
    strict.deepEqual(
      aggregate.columns.map((c) => [c.tsType, c.nullable, c.databaseType]),
      [
        ["string", false, "bigint"],
        ["number", true, "decimal(38,2)"],
      ],
    );
  });
});
