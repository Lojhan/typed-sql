import { parameterTypeLiteral, rowTypeLiteral } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import {
  defaultSqliteTypePolicy,
  mapSqliteType,
  parseSqliteSchemaSnapshot,
  type SqliteSchemaSnapshot,
  sqlite,
  sqliteAffinity,
} from "../src/index.js";

const flexible = "bigint | number | string | Uint8Array";
const schema = parseSqliteSchemaSnapshot({
  formatVersion: 1,
  dialect: "sqlite",
  dialectVersion: "1.0.0",
  tables: {
    account: {
      schema: "main",
      name: "account",
      kind: "table",
      strict: true,
      withoutRowid: false,
      indexes: [],
      foreignKeys: [],
      columns: {
        id: { name: "id", databaseType: "INTEGER", tsType: "bigint", nullable: false },
        email: { name: "email", databaseType: "TEXT", tsType: "string", nullable: false },
        score: { name: "score", databaseType: "REAL", tsType: "number", nullable: true },
        normalized: {
          name: "normalized",
          databaseType: "TEXT",
          tsType: "string",
          nullable: true,
          generated: "stored",
        },
      },
    },
    event: {
      schema: "main",
      name: "event",
      kind: "table",
      strict: false,
      withoutRowid: false,
      indexes: [],
      foreignKeys: [],
      columns: {
        value: { name: "value", databaseType: "INTEGER", tsType: flexible, nullable: true },
      },
    },
  },
  functions: {
    "slug/1": {
      name: "slug",
      argumentTypes: ["TEXT"],
      databaseReturnType: "TEXT",
      returnType: "string",
      nullable: false,
      volatility: "immutable",
    },
  },
}) as SqliteSchemaSnapshot;

await describe("SQLite grammar", async () => {
  await it("implements SQLite affinity order and sound flexible-table mapping", () => {
    strict.strictEqual(sqliteAffinity("FLOATING POINT"), "integer");
    strict.strictEqual(sqliteAffinity("VARCHAR(255)"), "text");
    strict.strictEqual(sqliteAffinity("BLOB"), "blob");
    strict.strictEqual(sqliteAffinity("DOUBLE"), "real");
    strict.strictEqual(sqliteAffinity("DECIMAL(10, 2)"), "numeric");
    strict.strictEqual(mapSqliteType("INTEGER", defaultSqliteTypePolicy), flexible);
    strict.strictEqual(mapSqliteType("INTEGER", defaultSqliteTypePolicy, { strict: true }), "bigint");
  });

  await it("infers strict rows, joins, CTEs, functions, and ordered parameters", () => {
    const dialect = sqlite();
    const analysis = dialect.analyze(
      "WITH selected AS (SELECT id, email FROM account) SELECT selected.id, slug(selected.email) AS slug FROM selected WHERE selected.id >= ?",
      schema,
    );
    strict.deepStrictEqual(
      analysis.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(rowTypeLiteral(analysis.columns), '{ "id": bigint; "slug": string; }');
    strict.strictEqual(parameterTypeLiteral(1, analysis.parameters), "readonly [bigint]");
  });

  await it("keeps ordinary-table values and parameters honest", () => {
    const analysis = sqlite().analyze("SELECT value FROM event WHERE value = ?", schema);
    strict.strictEqual(rowTypeLiteral(analysis.columns), `{ "value": ${flexible} | null; }`);
    strict.strictEqual(parameterTypeLiteral(1, analysis.parameters), `readonly [${flexible} | null]`);
  });

  await it("aligns SQLite integer and truth-value expressions with runtime decoding", () => {
    const analysis = sqlite().analyze(
      "SELECT 1 AS one, TRUE AS truth, id = 1 AS matches, 'account:' || email AS label FROM account",
      schema,
    );
    strict.strictEqual(
      rowTypeLiteral(analysis.columns),
      '{ "one": bigint; "truth": bigint; "matches": bigint; "label": string; }',
    );
  });

  await it("infers INSERT, UPDATE, and DELETE RETURNING", () => {
    const dialect = sqlite();
    for (const source of [
      "INSERT INTO account (id, email) VALUES (?, ?) RETURNING id, email",
      "UPDATE account SET email = ? WHERE id = ? RETURNING id, email",
      "DELETE FROM account WHERE id = ? RETURNING id, email",
    ]) {
      const analysis = dialect.analyze(source, schema);
      strict.deepStrictEqual(
        analysis.diagnostics.filter(({ severity }) => severity === "error"),
        [],
      );
      strict.strictEqual(rowTypeLiteral(analysis.columns), '{ "id": bigint; "email": string; }');
      strict.strictEqual(analysis.resultKind, "rows");
    }
  });

  await it("infers compound SELECT output types and validates arity", () => {
    const dialect = sqlite();
    const analysis = dialect.analyze(
      "SELECT id AS value FROM account UNION ALL SELECT score AS value FROM account ORDER BY value",
      schema,
    );
    strict.deepStrictEqual(
      analysis.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(rowTypeLiteral(analysis.columns), '{ "value": bigint | number | null; }');
    strict.strictEqual(analysis.semantics.cardinality.maximum, "many");
    strict.deepStrictEqual(
      dialect
        .analyze(
          "SELECT id AS left_name FROM account UNION SELECT id AS right_name FROM account ORDER BY right_name",
          schema,
        )
        .diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.ok(
      dialect
        .analyze("SELECT id FROM account UNION SELECT id, email FROM account", schema)
        .diagnostics.some(({ code }) => code === "TSQ214"),
    );
  });

  await it("fails closed on PostgreSQL-only and unsupported syntax", () => {
    const dialect = sqlite();
    strict.ok(
      dialect
        .analyze("SELECT DISTINCT ON (id) id FROM account", schema)
        .diagnostics.some(({ code }) => code === "TSQ401"),
    );
    strict.ok(
      dialect.analyze("SELECT id FROM account FOR UPDATE", schema).diagnostics.some(({ code }) => code === "TSQ401"),
    );
    strict.ok(
      dialect.analyze("SELECT ARRAY[1] AS values", schema).diagnostics.some(({ severity }) => severity === "error"),
    );
    strict.ok(
      dialect
        .analyze("SELECT id FROM account WHERE email ILIKE ?", schema)
        .diagnostics.some(({ code }) => code === "TSQ401"),
    );
    strict.ok(
      dialect.analyze("DELETE FROM account USING event", schema).diagnostics.some(({ code }) => code === "TSQ401"),
    );
    strict.ok(
      dialect.analyze("UPDATE account SET normalized = ?", schema).diagnostics.some(({ code }) => code === "TSQ401"),
    );
  });
});
