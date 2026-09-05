import { parameterTypeLiteral, rowTypeLiteral } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { normalizeSqliteDatabaseType, sqliteNumericOperands } from "../src/catalog/index.js";
import { parseSqliteSchemaSnapshot, type SqliteSchemaSnapshot, sqlite } from "../src/index.js";
import { accountTable, serverEvidence } from "./helpers/schema.js";

const schema = parseSqliteSchemaSnapshot({
  formatVersion: 1,
  dialect: "sqlite",
  dialectVersion: "1.0.0",
  ...serverEvidence(),
  tables: {
    account: accountTable(),
  },
  functions: {},
}) as SqliteSchemaSnapshot;

function at(version: string, features: readonly string[] = []): SqliteSchemaSnapshot {
  return {
    ...schema,
    version,
    server: { product: "sqlite", version, versionKey: version, features, settings: {} },
  };
}

function errorCodes(source: string, snapshot: SqliteSchemaSnapshot): readonly string[] {
  return sqlite()
    .analyze(source, snapshot)
    .diagnostics.filter(({ severity }) => severity === "error")
    .map(({ code }) => code);
}

await describe("SQLite versioned catalogs", async () => {
  await it("selects built-ins at their documented SQLite release boundaries", () => {
    strict.ok(errorCodes("SELECT CONCAT('a', 'b') AS value", at("3.43.2")).includes("TSQ404"));
    strict.deepStrictEqual(errorCodes("SELECT CONCAT('a', 'b') AS value", at("3.44.0")), []);
    strict.ok(errorCodes("SELECT IIF(TRUE, 'yes') AS value", at("3.47.2")).includes("TSQ404"));
    strict.deepStrictEqual(errorCodes("SELECT IIF(TRUE, 'yes') AS value", at("3.48.0")), []);
    strict.ok(errorCodes("SELECT IIF(FALSE, 1, TRUE, 2) AS value", at("3.48.0")).includes("TSQ404"));
    strict.deepStrictEqual(errorCodes("SELECT IIF(FALSE, 1, TRUE, 2) AS value", at("3.49.0")), []);
    strict.ok(errorCodes("SELECT UNISTR('x') AS value", at("3.49.2")).includes("TSQ404"));
    strict.deepStrictEqual(errorCodes("SELECT UNISTR('x') AS value", at("3.50.0")), []);
  });

  await it("requires normalized version evidence for version-gated built-ins", () => {
    const missing = { ...schema, version: undefined, server: undefined } as unknown as SqliteSchemaSnapshot;
    strict.ok(errorCodes("SELECT STRING_AGG(email, ',') AS value FROM account", missing).includes("TSQ402"));
    strict.deepStrictEqual(errorCodes("SELECT LENGTH(email) AS value FROM account", missing), []);
  });

  await it("infers catalog result and nullability policies", () => {
    const analysis = sqlite().analyze(
      "SELECT " +
        "CONCAT(NULL, email) AS concatenated, " +
        "CONCAT_WS(NULL, email) AS separated, " +
        "IIF(TRUE, email, score) AS chosen, " +
        "LENGTH(email) AS size, " +
        "TOTAL(score) AS total, " +
        "STRING_AGG(email, ',') AS grouped " +
        "FROM account",
      schema,
    );
    strict.deepStrictEqual(
      analysis.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(
      rowTypeLiteral(analysis.columns),
      '{ "concatenated": string; "separated": string | null; "chosen": string | number | null; "size": bigint; "total": number; "grouped": string | null; }',
    );
  });

  await it("validates catalog arities and keeps parameter coercion ordered", () => {
    strict.ok(errorCodes("SELECT COALESCE(1) AS value", schema).includes("TSQ227"));
    const analysis = sqlite().analyze("SELECT IFNULL(?, email) AS value FROM account", schema);
    strict.deepStrictEqual(
      analysis.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(parameterTypeLiteral(1, analysis.parameters), "readonly [string]");
  });

  await it("uses reviewed operator and coercion data", () => {
    strict.strictEqual(normalizeSqliteDatabaseType(" DECIMAL(10, 2) UNSIGNED "), "decimal");
    strict.strictEqual(sqliteNumericOperands("INTEGER", "DOUBLE"), true);
    strict.strictEqual(sqliteNumericOperands("INTEGER", "TEXT"), false);
    const analysis = sqlite().analyze("SELECT id + score AS value, id IS NULL AS missing FROM account", schema);
    strict.deepStrictEqual(
      analysis.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(rowTypeLiteral(analysis.columns), '{ "value": bigint | number | null; "missing": bigint; }');
  });

  await it("gates JSON functions, operators, and table-valued functions by version and compile evidence", () => {
    strict.deepStrictEqual(errorCodes("SELECT JSON_ARRAY(1) AS value", at("3.39.0")), []);
    strict.ok(errorCodes("SELECT JSON_ARRAY(1) AS value", at("3.53.0", ["OMIT_JSON"])).includes("TSQ406"));
    const missingCompileEvidence = { ...at("3.53.0"), server: undefined } as unknown as SqliteSchemaSnapshot;
    strict.ok(errorCodes("SELECT JSON_ARRAY(1) AS value", missingCompileEvidence).includes("TSQ402"));
    strict.ok(errorCodes("SELECT '{}' -> '$' AS value", at("3.53.0", ["OMIT_JSON"])).includes("TSQ406"));
    strict.ok(errorCodes("SELECT JSONB('{}') AS value", at("3.44.2")).includes("TSQ404"));
    strict.deepStrictEqual(errorCodes("SELECT JSONB('{}') AS value", at("3.45.0")), []);
    strict.ok(errorCodes("SELECT JSON_VALID('{}', 1) AS value", at("3.44.2")).includes("TSQ404"));

    const table = sqlite().analyze(
      "SELECT item.key, item.value, item.type, item.parent FROM json_tree(?) AS item",
      at("3.53.0"),
    );
    strict.deepStrictEqual(
      table.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(
      rowTypeLiteral(table.columns),
      '{ "key": bigint | string | null; "value": bigint | number | string | null; "type": string; "parent": bigint | null; }',
    );
    strict.strictEqual(
      parameterTypeLiteral(1, table.parameters),
      "readonly [bigint | number | string | Uint8Array | null]",
    );
    const star = sqlite().analyze("SELECT * FROM json_each('{}')", at("3.53.0"));
    strict.deepStrictEqual(
      star.columns.map(({ name }) => name),
      ["key", "value", "type", "atom", "id", "parent", "fullkey", "path"],
    );
    strict.ok(errorCodes("SELECT item.value FROM jsonb_tree('{}') AS item", at("3.50.4")).includes("TSQ404"));
    const jsonbTable = sqlite().analyze("SELECT item.value FROM jsonb_tree('{}') AS item", at("3.51.0"));
    strict.strictEqual(
      rowTypeLiteral(jsonbTable.columns),
      '{ "value": bigint | number | string | Uint8Array | null; }',
    );
    strict.ok(errorCodes("SELECT JSON_ARRAY_INSERT('[]', '$[0]', 1) AS value", at("3.52.0")).includes("TSQ404"));
    strict.deepStrictEqual(errorCodes("SELECT JSON_ARRAY_INSERT('[]', '$[0]', 1) AS value", at("3.53.0")), []);
    strict.ok(errorCodes("SELECT value FROM carray(?)", at("3.53.0")).includes("TSQ406"));
    const carray = sqlite().analyze("SELECT value FROM carray(?)", at("3.53.0", ["ENABLE_CARRAY"]));
    strict.deepStrictEqual(
      carray.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(rowTypeLiteral(carray.columns), '{ "value": bigint | number | string | Uint8Array | null; }');
    strict.strictEqual(parameterTypeLiteral(1, carray.parameters), "readonly [unknown]");
    strict.deepStrictEqual(
      errorCodes("SELECT id FROM account WHERE id IN carray(?)", at("3.53.0", ["ENABLE_CARRAY"])),
      [],
    );
  });

  await it("models date/time return classes and versioned modifiers", () => {
    const analysis = sqlite().analyze(
      "SELECT CURRENT_TIMESTAMP AS now, DATE('now') AS day, JULIANDAY('now') AS julian, UNIXEPOCH('now') AS seconds, UNIXEPOCH('now', 'subsec') AS fractional",
      at("3.53.0"),
    );
    strict.deepStrictEqual(
      analysis.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(
      rowTypeLiteral(analysis.columns),
      '{ "now": string; "day": string | null; "julian": number | null; "seconds": bigint | null; "fractional": number | null; }',
    );
    strict.ok(errorCodes("SELECT TIMEDIFF('now', 'now') AS value", at("3.42.0")).includes("TSQ404"));
    strict.deepStrictEqual(errorCodes("SELECT TIMEDIFF('now', 'now') AS value", at("3.43.0")), []);
    strict.ok(errorCodes("SELECT UNIXEPOCH('now', 'subsec') AS value", at("3.41.2")).includes("TSQ404"));
    strict.strictEqual(
      rowTypeLiteral(sqlite().analyze("SELECT UNIXEPOCH('subsec') AS value", at("3.53.0")).columns),
      '{ "value": number | null; }',
    );
    strict.ok(errorCodes("SELECT DATE('now', 'floor') AS value", at("3.45.3")).includes("TSQ404"));
    strict.ok(errorCodes("SELECT STRFTIME('%G', 'now') AS value", at("3.45.3")).includes("TSQ404"));
  });

  await it("requires explicit compile options for math and optional extension families", () => {
    strict.ok(errorCodes("SELECT SQRT(4) AS value", at("3.53.0")).includes("TSQ406"));
    const math = sqlite().analyze("SELECT SQRT(4) AS root, PI() AS pi", at("3.53.0", ["ENABLE_MATH_FUNCTIONS"]));
    strict.deepStrictEqual(
      math.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(rowTypeLiteral(math.columns), '{ "root": number | null; "pi": number; }');
    const mathParameter = sqlite().analyze("SELECT SQRT(?) AS root", at("3.53.0", ["ENABLE_MATH_FUNCTIONS"]));
    strict.strictEqual(parameterTypeLiteral(1, mathParameter.parameters), "readonly [bigint | number | null]");
    strict.ok(errorCodes("SELECT SOUNDEX('hello') AS value", at("3.53.0")).includes("TSQ406"));
    strict.deepStrictEqual(errorCodes("SELECT SOUNDEX('hello') AS value", at("3.53.0", ["SOUNDEX"])), []);
    strict.ok(
      errorCodes("SELECT MEDIAN(score) AS value FROM account", at("3.50.4", ["ENABLE_PERCENTILE"])).includes("TSQ404"),
    );
    strict.ok(errorCodes("SELECT MEDIAN(score) AS value FROM account", at("3.53.0")).includes("TSQ406"));
    strict.deepStrictEqual(
      errorCodes("SELECT MEDIAN(score) AS value FROM account", at("3.53.0", ["ENABLE_PERCENTILE"])),
      [],
    );
  });
});
