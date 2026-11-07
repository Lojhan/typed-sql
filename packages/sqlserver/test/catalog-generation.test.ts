import { describe, it, strict } from "poku";
import { parseSqlServerNativeType } from "../src/native-types.js";
import { mapSqlServerType } from "../src/type-policy.js";
import { grammar, snapshot } from "./helpers/maturity-corpus.js";

await describe("generated SQL Server logical identity and contextual defaults", async () => {
  await it("does not confuse an unqualified VECTOR type with its VARBINARY storage identity", () => {
    strict.equal(parseSqlServerNativeType("vector"), undefined);
    strict.equal(mapSqlServerType("vector"), "unknown");
    strict.equal(parseSqlServerNativeType("sysname")?.text, "nvarchar(128)");
    const source = "SELECT CAST(NULL AS vector) AS value";
    const result = grammar.analyze(source, snapshot);
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
    strict.ok(result.columns.every((column) => column.tsType !== "Uint8Array"));
    strict.deepEqual(result.parameters, []);
    for (const diagnostic of result.diagnostics) {
      strict.ok(diagnostic.range.start >= 0 && diagnostic.range.end <= source.length);
      strict.ok(source.slice(diagnostic.range.start, diagnostic.range.end).includes("vector"));
    }
  });

  await it("retains declaration defaults while CAST and CONVERT use their own length defaults", () => {
    // Microsoft documents length 1 for declarations and 30 for CAST/CONVERT.
    for (const name of ["char", "varchar", "nchar", "nvarchar", "binary", "varbinary"]) {
      strict.equal(parseSqlServerNativeType(name)?.text, `${name}(1)`);
      strict.equal(parseSqlServerNativeType(name, "cast")?.text, `${name}(30)`);
      strict.equal(parseSqlServerNativeType(`${name}(7)`, "cast")?.text, `${name}(7)`);
      for (const expression of [
        `CAST(NULL AS ${name})`,
        `TRY_CAST(NULL AS ${name})`,
        `CONVERT(${name},NULL)`,
        `TRY_CONVERT(${name},NULL)`,
      ]) {
        const source = `SELECT ${expression} AS value`;
        const result = grammar.analyze(source, snapshot);
        strict.deepEqual(result.diagnostics, [], source);
        strict.deepEqual(result.parameters, []);
        strict.equal(
          result.columns[0]?.databaseType,
          `${name}(30)${name.includes("binary") ? "" : " COLLATE Latin1_General_100_CI_AS"}`,
          source,
        );
        strict.equal(result.columns[0]?.nullable, true);
        strict.equal(result.columns[0]?.tsType, name.includes("binary") ? "Uint8Array" : "string");
        const range = result.columns[0]!.range;
        strict.ok(source.slice(range.start, range.end).includes(expression));
      }
    }
  });
});
