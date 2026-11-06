import { describe, it, strict } from "poku";
import { sqlserver } from "../src/browser.js";
import { snapshot } from "./helpers/maturity-corpus.js";

const grammar = sqlserver();
// Actual table and constant SQL_VARIANT_PROPERTY + DMF evidence across engine14–17 and all10 compat targets.
// https://github.com/Lojhan/typed-sql/actions/runs/42108197287
// The current Microsoft ABS reference claims precision38; qualified engines consistently retain input precision.
const decimals = {
  ABS: "decimal(12,2)",
  CEILING: "decimal(12,0)",
  FLOOR: "decimal(12,0)",
  POWER: "decimal(38,2)",
  SIGN: "decimal(12,2)",
  DEGREES: "decimal(38,18)",
  RADIANS: "decimal(38,18)",
} as const;
await describe("SQL Server native numeric promotion evidence", async () => {
  for (const [name, databaseType] of Object.entries(decimals))
    await it(`${name} uses qualified decimal metadata rather than an unverified generic rule`, () => {
      const result = grammar.analyze(
        `SELECT ${name}(amount${name === "POWER" ? ",2" : ""}) AS value FROM dbo.widgets`,
        snapshot,
      );
      strict.deepEqual(result.diagnostics, []);
      strict.equal(result.columns[0]?.databaseType, databaseType);
      strict.equal(result.columns[0]?.tsType, "string");
      strict.equal(result.columns[0]?.nullable, false);
    });
  for (const name of Object.keys(decimals))
    for (const [input, output, tsType] of [
      ["int", "int", "number"],
      ["smallint", "int", "number"],
      ["money", "money", "string"],
      ["bit", "float(53)", "number"],
      ["real", "float(53)", "number"],
    ] as const)
      await it(`${name}(${input}) preserves the actual native return family`, () => {
        const result = grammar.analyze(
          `SELECT ${name}(CAST(1 AS ${input})${name === "POWER" ? ",2" : ""}) AS value`,
          snapshot,
        );
        strict.deepEqual(result.diagnostics, []);
        strict.equal(result.columns[0]?.databaseType, output);
        strict.equal(result.columns[0]?.tsType, tsType);
      });
});
