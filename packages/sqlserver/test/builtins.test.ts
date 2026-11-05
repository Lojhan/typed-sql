import { upgradeSchemaSnapshotV1 } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { grammar, snapshot } from "./helpers/maturity-corpus.js";

// https://learn.microsoft.com/en-us/sql/t-sql/functions/percentile-disc-transact-sql
// https://learn.microsoft.com/en-us/sql/t-sql/functions/percentile-cont-transact-sql
await describe("SQL Server ordered statistics and function namespaces", async () => {
  await it("returns the sorted native value for a discrete percentile and float for interpolation", () => {
    for (const [name, column, type] of [
      ["PERCENTILE_DISC", "amount", "decimal(12,2)"],
      ["PERCENTILE_DISC", "id", "bigint"],
      ["PERCENTILE_CONT", "quantity", "float(53)"],
    ] as const) {
      const source = `SELECT ${name}(0.5) WITHIN GROUP (ORDER BY ${column}) OVER (PARTITION BY active) AS value FROM dbo.widgets`;
      const result = grammar.analyze(source, snapshot);
      strict.deepEqual(result.diagnostics, [], source);
      strict.equal(result.columns[0]?.databaseType, type);
      strict.equal(result.columns[0]?.nullable, true);
      strict.equal(result.semantics?.cardinality.maximum, "many");
    }
  });
  await it("rejects invalid ordered statistic contexts, dynamic percentages and DEFAULT-only UUID generation", () => {
    for (const expression of [
      "PERCENTILE_DISC(0.5) OVER ()",
      "PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY id,quantity) OVER ()",
      "PERCENTILE_DISC(1.1) WITHIN GROUP (ORDER BY id) OVER ()",
      "PERCENTILE_DISC(@__typed_sql_1) WITHIN GROUP (ORDER BY id) OVER ()",
      "PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY code) OVER ()",
      "PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY id) OVER (ORDER BY id)",
      "PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY id)",
      "NEWSEQUENTIALID()",
    ]) {
      const source = `SELECT ${expression} AS value FROM dbo.widgets`,
        result = grammar.analyze(source, snapshot);
      strict.ok(
        result.diagnostics.some((d) => d.severity === "error"),
        source,
      );
      strict.equal(result.semantics?.operation.value, "unknown");
    }
  });
  await it("resolves table function schema, input arity and native output evidence together", () => {
    const upgraded = upgradeSchemaSnapshotV1(snapshot),
      columns = upgraded.relations.widgets!.columns;
    const routine = {
      name: "records",
      schema: "custom",
      identity: "records",
      kind: "function" as const,
      arguments: [
        {
          mode: "in" as const,
          databaseType: "bigint",
          tsType: "bigint",
          typeIdentity: "bigint",
          default: "none" as const,
        },
      ],
      result: { kind: "table" as const, columns: { id: columns.id! } },
      volatility: "immutable" as const,
      deterministic: true,
      dataAccess: "reads-sql" as const,
      nullInput: "called" as const,
    };
    const schema = { ...upgraded, dialect: "sqlserver" as const, routines: { records: [routine] } };
    const source = "SELECT r.id FROM custom.records(@__typed_sql_1) AS r",
      result = grammar.analyze(source, schema);
    strict.deepEqual(result.diagnostics, []);
    strict.equal(result.columns[0]?.tsType, "bigint");
    strict.equal(result.parameters[0]?.databaseType, "bigint");
    for (const table of [
      "other.records(1)",
      "custom.records()",
      "custom.records(1,2)",
      "custom.OPENJSON(N'[]')",
      "custom.STRING_SPLIT(N'a',N',')",
    ]) {
      const invalid = grammar.analyze(`SELECT * FROM ${table} AS r`, schema);
      strict.ok(
        invalid.diagnostics.some((d) => d.code === "TSQ105"),
        table,
      );
    }
  });
  // https://learn.microsoft.com/en-us/sql/t-sql/functions/lag-transact-sql
  await it("keeps analytic value, numeric offset and default parameter targets separate", () => {
    for (const name of ["LAG", "LEAD"]) {
      const source = `SELECT ${name}(code,@__typed_sql_1,@__typed_sql_2) OVER(ORDER BY id) AS value FROM dbo.widgets`;
      const result = grammar.analyze(source, snapshot);
      strict.deepEqual(result.diagnostics, []);
      strict.deepEqual(
        result.parameters.map((parameter) => [parameter.index, parameter.databaseType]),
        [
          [1, "bigint"],
          [2, "nvarchar(40) COLLATE Latin1_General_100_CI_AS"],
        ],
      );
      strict.equal(result.columns[0]?.databaseType, "nvarchar(40) COLLATE Latin1_General_100_CI_AS");
    }
    for (const expression of [
      "LAG(code,-1) OVER(ORDER BY id)",
      "LAG(ROW_NUMBER() OVER(ORDER BY id)) OVER(ORDER BY id)",
      "MAX(payload)",
      "MIN(payload)",
    ]) {
      const result = grammar.analyze(`SELECT ${expression} AS value FROM dbo.widgets`, snapshot);
      strict.ok(
        result.diagnostics.some((d) => d.severity === "error"),
        expression,
      );
      strict.equal(result.semantics?.operation.value, "unknown");
    }
  });
  await it("never borrows local function metadata for another database or linked server", () => {
    const schema = {
      ...snapshot,
      server: { ...snapshot.server, settings: { ...snapshot.server.settings, databaseName: "commerce" } },
      functions: {
        make: {
          name: "make",
          schema: "custom",
          argumentTypes: ["int"],
          databaseReturnType: "bigint",
          returnType: "bigint",
          nullable: false,
        },
      },
    };
    const local = grammar.analyze("SELECT commerce.custom.make(quantity) AS value FROM dbo.widgets", schema);
    strict.deepEqual(local.diagnostics, []);
    strict.equal(local.columns[0]?.tsType, "bigint");
    for (const name of ["other.custom.make", "linked.commerce.custom.make"]) {
      const result = grammar.analyze(`SELECT ${name}(quantity) AS value FROM dbo.widgets`, schema);
      strict.ok(result.diagnostics.some((d) => d.code === "TSQ108"));
      strict.equal(result.semantics?.operation.value, "unknown");
    }
    const table = grammar.analyze("SELECT * FROM other.custom.records(1) AS r", schema);
    strict.ok(table.diagnostics.some((d) => d.code === "TSQ108"));
  });
});
