import { parameterTypeLiteral, rowTypeLiteral } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { parseSqliteSchemaSnapshot, type SqliteSchemaSnapshot, sqlite } from "../src/index.js";

const snapshot = parseSqliteSchemaSnapshot({
  formatVersion: 1,
  dialect: "sqlite",
  dialectVersion: "1.0.0",
  version: "3.53.0",
  server: {
    product: "sqlite",
    version: "3.53.0",
    versionKey: "3.53.0",
    features: [],
    settings: {},
  },
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
        generated: {
          name: "generated",
          databaseType: "TEXT",
          tsType: "string",
          nullable: true,
          generated: "virtual",
        },
      },
    },
    audit: {
      schema: "main",
      name: "audit",
      kind: "table",
      strict: true,
      withoutRowid: false,
      indexes: [],
      foreignKeys: [],
      columns: {
        id: { name: "id", databaseType: "INTEGER", tsType: "bigint", nullable: false },
        account_id: { name: "account_id", databaseType: "INTEGER", tsType: "bigint", nullable: false },
        note: { name: "note", databaseType: "TEXT", tsType: "string", nullable: true },
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

function errors(sql: string): readonly string[] {
  return sqlite()
    .analyze(sql, snapshot)
    .diagnostics.map(({ code }) => code);
}

await describe("SQLite soundness matrix", async () => {
  await it("covers aliases, stars, joins, subqueries, windows, and scalar expressions", () => {
    const cases = [
      [
        "SELECT account.* FROM account",
        '{ "id": bigint; "email": string; "score": number | null; "generated": string | null; }',
      ],
      [
        "SELECT * FROM account JOIN audit USING (id)",
        '{ "id": bigint; "email": string; "score": number | null; "generated": string | null; "account_id": bigint; "note": string | null; }',
      ],
      ["SELECT audit.id FROM account RIGHT JOIN audit ON account.id = audit.account_id", '{ "id": bigint; }'],
      [
        "SELECT (SELECT email FROM account WHERE id = audit.account_id) AS email FROM audit",
        '{ "email": string | null; }',
      ],
      [
        "SELECT EXISTS (SELECT 1 AS one FROM audit WHERE audit.account_id = account.id) AS present FROM account",
        '{ "present": bigint; }',
      ],
      ["SELECT CASE WHEN score IS NULL THEN 'none' ELSE email END AS label FROM account", '{ "label": string; }'],
      ["SELECT CAST(score AS INTEGER) AS score FROM account", '{ "score": bigint | null; }'],
      ["SELECT (id, email) AS pair FROM account", '{ "pair": readonly [bigint, string]; }'],
      [
        "SELECT COUNT(*) FILTER (WHERE score > 0) OVER (PARTITION BY email ORDER BY id) AS total FROM account",
        '{ "total": bigint; }',
      ],
      ["SELECT id FROM account WHERE id IN (1, 2) AND score BETWEEN 1 AND 3", '{ "id": bigint; }'],
      ["SELECT id FROM account WHERE id IN (SELECT account_id FROM audit)", '{ "id": bigint; }'],
      [
        "SELECT email || ':' || id AS label, '{}' -> 'value' AS json, '{}' ->> 'value' AS value FROM account",
        '{ "label": string; "json": string | null; "value": bigint | number | string | Uint8Array | null; }',
      ],
    ] as const;
    for (const [source, expected] of cases) {
      const analysis = sqlite().analyze(source, snapshot);
      strict.deepStrictEqual(
        analysis.diagnostics.filter(({ severity }) => severity === "error"),
        [],
        source,
      );
      strict.strictEqual(rowTypeLiteral(analysis.columns), expected, source);
    }
  });

  await it("covers built-ins, configured functions, parameters, and alternate policies", () => {
    const analysis = sqlite().analyze(
      "SELECT SUM(score) AS total, AVG(score) AS average, MIN(score) AS minimum, MAX(account.id) AS maximum, COALESCE(note, email) AS value, IFNULL(note, email) AS fallback, NULLIF(email, ?) AS nulled, GROUP_CONCAT(email) AS grouped, JSON_ARRAY(account.id) AS json, RANDOM() AS random, LENGTH(email) AS length, slug(?) AS slug FROM account LEFT JOIN audit ON audit.account_id = account.id",
      snapshot,
    );
    strict.deepStrictEqual(
      analysis.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(parameterTypeLiteral(2, analysis.parameters), "readonly [string, string | null]");
    strict.ok(rowTypeLiteral(analysis.columns).includes('"slug": string'));

    const numbers = sqlite({ typePolicy: { integer: "number", flexible: "unknown", unknown: "never" } }).analyze(
      "SELECT COUNT(*) AS total, 1 AS literal, TRUE AS truth",
      snapshot,
    );
    strict.strictEqual(rowTypeLiteral(numbers.columns), '{ "total": number; "literal": number; "truth": number; }');
  });

  await it("fails closed across invalid relation, projection, CTE, DML, and expression shapes", () => {
    const matrix: readonly [string, string][] = [
      ["SELECT *", "TSQ103"],
      ["SELECT missing.* FROM account", "TSQ103"],
      ["SELECT missing FROM account", "TSQ101"],
      ["SELECT missing.id FROM account", "TSQ103"],
      ["SELECT id FROM account JOIN audit ON account.id = audit.id", "TSQ102"],
      ["SELECT id FROM account JOIN audit USING (missing)", "TSQ215"],
      ["SELECT account.id FROM account JOIN audit AS account ON account.id = account.id", "TSQ108"],
      ["SELECT id AS value, email AS value FROM account", "TSQ105"],
      ["SELECT id + email FROM account", "TSQ104"],
      ["SELECT id + email AS invalid FROM account", "TSQ203"],
      ["SELECT ARRAY[1] AS invalid", "TSQ001"],
      ["SELECT (SELECT id, email FROM account) AS invalid", "TSQ216"],
      ["SELECT id FROM account WHERE id IN (SELECT id, account_id FROM audit)", "TSQ217"],
      ["SELECT unknown_function(id) AS invalid FROM account", "TSQ202"],
      [
        "WITH RECURSIVE selected(id) AS (SELECT selected.id FROM selected UNION ALL SELECT id FROM account) SELECT id FROM selected",
        "TSQ220",
      ],
      ["WITH selected(a, b) AS (SELECT id FROM account) SELECT a FROM selected", "TSQ213"],
      [
        "WITH selected AS (SELECT id FROM account), selected AS (SELECT id FROM audit) SELECT id FROM selected",
        "TSQ211",
      ],
      ["SELECT id FROM missing", "TSQ100"],
      ["INSERT INTO account (id, email) VALUES (?)", "TSQ214"],
      ["INSERT INTO account (id) SELECT id, account_id FROM audit", "TSQ214"],
      ["INSERT INTO account (generated) VALUES (?)", "TSQ218"],
      ["UPDATE account SET missing = ?", "TSQ101"],
      ["UPDATE account SET generated = ?", "TSQ218"],
      ["DELETE FROM account USING audit", "TSQ401"],
    ];
    for (const [source, code] of matrix) strict.ok(errors(source).includes(code), `${source} should report ${code}`);
  });

  await it("reports parse failures and rejects incompatible snapshots and placeholder indexes", () => {
    const dialect = sqlite();
    strict.strictEqual(dialect.analyze("SELECT (", snapshot).diagnostics[0]?.code, "TSQ001");
    strict.throws(() => dialect.placeholder(0), /start at 1/);
    strict.strictEqual(dialect.placeholder(2), "?");
    strict.strictEqual(dialect.quoteIdentifier('a"b'), '"a""b"');
    strict.throws(
      () => dialect.validateSnapshot({ ...snapshot, dialectVersion: "9.0.0" }),
      /cannot use snapshot dialectVersion/,
    );
  });
});
