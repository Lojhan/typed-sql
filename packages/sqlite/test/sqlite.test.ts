import { parameterTypeLiteral, resolveDialectCapabilityStates, rowTypeLiteral } from "@typed-sql/core";
import { serializeSchemaSnapshot, upgradeSchemaSnapshotV1 } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import {
  defaultSqliteTypePolicy,
  mapSqliteType,
  NODE_SQLITE_RUNTIME_SUPPORT,
  parseSqliteSchemaSnapshot,
  SQLITE_LANGUAGE_SUPPORT,
  type SqliteSchemaSnapshot,
  sqlite,
  sqliteAffinity,
  sqliteVersionSupport,
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
      indexes: [
        {
          name: "sqlite_autoindex_account_1",
          unique: true,
          partial: false,
          origin: "primary-key",
          columns: [{ name: "id" }],
        },
      ],
      foreignKeys: [],
      columns: {
        id: {
          name: "id",
          databaseType: "INTEGER",
          tsType: "bigint",
          nullable: false,
          primaryKeyPosition: 1,
        },
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

const v2Schema = (() => {
  if (schema.formatVersion !== 1) throw new Error("expected the legacy SQLite fixture");
  const upgraded = upgradeSchemaSnapshotV1(schema);
  const account = upgraded.relations.account!;
  const snapshot = {
    ...upgraded,
    relations: {
      ...upgraded.relations,
      account: {
        ...account,
        columns: {
          ...account.columns,
          id: { ...account.columns.id!, default: "present", identity: "none", insertable: true, updatable: true },
          email: { ...account.columns.email!, default: "none", identity: "none", insertable: true, updatable: true },
          normalized: {
            ...account.columns.normalized!,
            default: "none",
            generated: "stored",
            identity: "none",
            insertable: false,
            updatable: false,
          },
        },
      },
    },
  } as const;
  return parseSqliteSchemaSnapshot(JSON.parse(serializeSchemaSnapshot(snapshot)) as unknown);
})();

await describe("SQLite grammar", async () => {
  await it("resolves feature support from actual SQLite version evidence", () => {
    const dialect = sqlite();
    const current = resolveDialectCapabilityStates(dialect, {
      ...schema,
      version: "3.53.0",
      server: {
        product: "sqlite",
        version: "3.53.0",
        versionKey: "3.53.0",
        features: [],
        settings: {},
      },
    });
    strict.strictEqual(current.returning?.level, "exact");
    strict.strictEqual(current.fullJoins?.level, "exact");
    const old = dialect.resolveCapabilities?.({ ...schema, version: "3.34.1" });
    strict.strictEqual(old?.returning?.level, "unsupported");
    strict.strictEqual(old?.returning?.diagnostic, "TSQ404");
    strict.strictEqual(old?.aggregateFilter?.level, "conservative");
    strict.strictEqual(dialect.resolveCapabilities?.(schema).returning?.level, "conservative");
    const omittedWindows = dialect.resolveCapabilities?.({
      ...schema,
      server: {
        product: "sqlite",
        version: "3.53.0",
        versionKey: "3.53.0",
        features: ["OMIT_WINDOWFUNC"],
        settings: {},
      },
    });
    strict.strictEqual(omittedWindows?.aggregateFilter?.level, "unsupported");
    strict.strictEqual(omittedWindows?.aggregateFilter?.diagnostic, "TSQ406");
    strict.strictEqual(SQLITE_LANGUAGE_SUPPORT.minimum, "3.39.0");
    strict.strictEqual(SQLITE_LANGUAGE_SUPPORT.maximum, "3.53.4");
    strict.strictEqual(NODE_SQLITE_RUNTIME_SUPPORT.minimum, "22.13.0");
    strict.strictEqual(sqliteVersionSupport("3.53.4"), "supported");
    strict.strictEqual(sqliteVersionSupport("3.54.0"), "newer-than-tested");
    strict.strictEqual(sqliteVersionSupport("3.53.5rc1"), "prerelease");
    strict.strictEqual(
      dialect.resolveCapabilities?.({
        ...schema,
        version: "3.54.0",
        server: {
          product: "sqlite",
          version: "3.54.0",
          versionKey: "3.54.0",
          features: [],
          settings: {},
        },
      }).setOperations?.level,
      "conservative",
    );
    strict.strictEqual(
      dialect.analyze("UPDATE account SET email = ? RETURNING id", { ...schema, version: "3.34.1" }).diagnostics[0]
        ?.code,
      "TSQ404",
    );
  });

  await it("implements SQLite affinity order and sound flexible-table mapping", () => {
    strict.strictEqual(sqliteAffinity("FLOATING POINT"), "integer");
    strict.strictEqual(sqliteAffinity("VARCHAR(255)"), "text");
    strict.strictEqual(sqliteAffinity("BLOB"), "blob");
    strict.strictEqual(sqliteAffinity("DOUBLE"), "real");
    strict.strictEqual(sqliteAffinity("DECIMAL(10, 2)"), "numeric");
    strict.strictEqual(mapSqliteType("INTEGER", defaultSqliteTypePolicy), flexible);
    strict.strictEqual(mapSqliteType("INTEGER", defaultSqliteTypePolicy, { strict: true }), "bigint");
  });

  await it("rejects non-allowlisted SQLite server settings", () => {
    strict.throws(
      () =>
        sqlite().validateSnapshot({
          ...schema,
          server: {
            product: "sqlite",
            version: "3.53.0",
            versionKey: "3.53.0",
            features: [],
            settings: { foreignKeys: true },
          },
        }),
      /does not allow semantic settings/u,
    );
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

  await it("uses neutral v2 write eligibility and required-column evidence", () => {
    const dialect = sqlite();
    const invalidInsert = dialect.analyze("INSERT INTO account (normalized) VALUES ('x')", v2Schema);
    strict.ok(invalidInsert.diagnostics.some(({ code }) => code === "TSQ218"));
    strict.ok(invalidInsert.diagnostics.some(({ code }) => code === "TSQ219"));
    const invalidUpdate = dialect.analyze("UPDATE account SET normalized = 'x'", v2Schema);
    strict.ok(invalidUpdate.diagnostics.some(({ code }) => code === "TSQ218"));
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

  await it("infers recursive CTEs from seed columns and positional recursive members", () => {
    const dialect = sqlite();
    for (const keyword of ["WITH RECURSIVE", "WITH"]) {
      const analysis = dialect.analyze(
        `${keyword} selected(id) AS (` +
          "SELECT id FROM account UNION ALL SELECT selected.id FROM selected" +
          ") SELECT id FROM selected",
        schema,
      );
      strict.deepStrictEqual(
        analysis.diagnostics.filter(({ severity }) => severity === "error"),
        [],
      );
      strict.strictEqual(rowTypeLiteral(analysis.columns), '{ "id": bigint; }');
      strict.deepStrictEqual(analysis.semantics.capabilities, ["recursiveCtes", "setOperations"]);
    }
    const counted = dialect.analyze(
      "WITH RECURSIVE cnt(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM cnt WHERE value < ?) SELECT value FROM cnt",
      schema,
    );
    strict.deepStrictEqual(
      counted.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(rowTypeLiteral(counted.columns), '{ "value": bigint | number; }');
    strict.strictEqual(parameterTypeLiteral(1, counted.parameters), "readonly [bigint]");
  });

  await it("rejects invalid SQLite recursive-member shapes with stable spans", () => {
    const dialect = sqlite();
    for (const source of [
      "WITH RECURSIVE cnt(x) AS (SELECT x FROM cnt UNION ALL SELECT 1) SELECT x FROM cnt",
      "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT (SELECT x FROM cnt)) SELECT x FROM cnt",
      "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT a.x FROM cnt a JOIN cnt b ON a.x = b.x) SELECT x FROM cnt",
      "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x FROM cnt UNION ALL SELECT 2) SELECT x FROM cnt",
      "WITH RECURSIVE cnt(x) AS (SELECT 1 INTERSECT SELECT x FROM cnt) SELECT x FROM cnt",
      "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x FROM cnt UNION SELECT x FROM cnt) SELECT x FROM cnt",
    ]) {
      const diagnostic = dialect.analyze(source, schema).diagnostics.find(({ code }) => code === "TSQ220");
      strict.ok(diagnostic, source);
      strict.ok(diagnostic?.range.start !== undefined && diagnostic.range.start >= source.indexOf("cnt(x)"), source);
      strict.ok(
        diagnostic?.range.end !== undefined && diagnostic.range.end <= source.lastIndexOf(") SELECT") + 1,
        source,
      );
    }
    const aggregate = dialect.analyze(
      "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT COUNT(*) FROM cnt) SELECT x FROM cnt",
      schema,
    );
    strict.ok(aggregate.diagnostics.some(({ code }) => code === "TSQ221"));
  });

  await it("infers SQLite built-in windows, frames, and chaining nullability", () => {
    const analysis = sqlite().analyze(
      "SELECT " +
        "ROW_NUMBER() OVER recent AS position, " +
        "LAG(email, 1, 'missing') OVER recent AS previous, " +
        "FIRST_VALUE(score) OVER (base ORDER BY id GROUPS BETWEEN CURRENT ROW AND 1 FOLLOWING EXCLUDE TIES) AS first_score " +
        "FROM account " +
        "WINDOW base AS (PARTITION BY email), recent AS (base ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)",
      schema,
    );
    strict.deepStrictEqual(
      analysis.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(
      rowTypeLiteral(analysis.columns),
      '{ "position": bigint; "previous": string; "first_score": number | null; }',
    );
  });

  await it("fails closed on invalid SQLite window definitions and modifiers", () => {
    const dialect = sqlite();
    for (const source of [
      "SELECT ROW_NUMBER() OVER missing AS position FROM account",
      "SELECT SUM(score) OVER (RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) AS total FROM account",
      "SELECT SUM(score) OVER (ORDER BY id, email RANGE 1 PRECEDING) AS total FROM account",
      "SELECT SUM(score) OVER child AS total FROM account WINDOW base AS (PARTITION BY email), child AS (base PARTITION BY id)",
      "SELECT SUM(score) OVER (ORDER BY id ROWS id PRECEDING) AS total FROM account",
    ]) {
      strict.ok(
        dialect.analyze(source, schema).diagnostics.some(({ code }) => code === "TSQ222"),
        source,
      );
    }
    for (const source of [
      "SELECT ROW_NUMBER(DISTINCT id) OVER () AS position FROM account",
      "SELECT ROW_NUMBER() FILTER (WHERE id > 0) OVER () AS position FROM account",
      "SELECT ROW_NUMBER(id) OVER () AS position FROM account",
      "SELECT ROW_NUMBER() AS position FROM account",
      "SELECT id FROM account WHERE ROW_NUMBER() OVER () > 1",
    ]) {
      strict.ok(
        dialect.analyze(source, schema).diagnostics.some(({ code }) => code === "TSQ223"),
        source,
      );
    }
  });

  await it("infers SQLite conflict algorithms and UPSERT actions", () => {
    const dialect = sqlite();
    for (const source of [
      "INSERT OR IGNORE INTO account (id, email) VALUES (?, ?)",
      "REPLACE INTO account (id, email) VALUES (?, ?)",
      "UPDATE OR FAIL account SET email = ? WHERE id = ?",
    ]) {
      strict.deepStrictEqual(
        dialect.analyze(source, schema).diagnostics.filter(({ severity }) => severity === "error"),
        [],
        source,
      );
    }
    const upsert = dialect.analyze(
      "INSERT INTO account (id, email) VALUES (?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET email = excluded.email WHERE excluded.id = ? " +
        "ON CONFLICT DO NOTHING RETURNING id, email",
      schema,
    );
    strict.deepStrictEqual(
      upsert.diagnostics.filter(({ severity }) => severity === "error"),
      [],
    );
    strict.strictEqual(rowTypeLiteral(upsert.columns), '{ "id": bigint; "email": string; }');
    strict.strictEqual(parameterTypeLiteral(3, upsert.parameters), "readonly [bigint, string, bigint]");
  });

  await it("enforces SQLite UPSERT, RETURNING, and UPDATE FROM restrictions", () => {
    const dialect = sqlite();
    strict.ok(
      dialect
        .analyze("INSERT INTO account (id, email) SELECT id, email FROM account ON CONFLICT (id) DO NOTHING", schema)
        .diagnostics.some(({ code }) => code === "TSQ224"),
    );
    strict.ok(
      dialect
        .analyze(
          "INSERT INTO account (id, email) VALUES (?, ?) ON CONFLICT DO NOTHING ON CONFLICT (id) DO NOTHING",
          schema,
        )
        .diagnostics.some(({ code }) => code === "TSQ224"),
    );
    strict.ok(
      dialect
        .analyze("INSERT INTO account (id, email) VALUES (?, ?) ON CONFLICT (email) DO NOTHING", schema)
        .diagnostics.some(({ code }) => code === "TSQ226"),
    );
    strict.ok(
      dialect
        .analyze("INSERT INTO account (id, email) VALUES (?, ?) ON CONFLICT (id) WHERE id > 0 DO NOTHING", schema)
        .diagnostics.some(({ code }) => code === "TSQ402"),
    );
    for (const source of [
      "UPDATE account SET email = email RETURNING COUNT(*) AS total",
      "DELETE FROM account RETURNING ROW_NUMBER() OVER () AS position",
    ]) {
      strict.ok(
        dialect.analyze(source, schema).diagnostics.some(({ code }) => code === "TSQ225"),
        source,
      );
    }
    const subquery = dialect.analyze(
      "UPDATE account SET email = email RETURNING (SELECT COUNT(*) FROM event) AS total",
      schema,
    );
    strict.ok(!subquery.diagnostics.some(({ code }) => code === "TSQ225"));
    strict.strictEqual(rowTypeLiteral(subquery.columns), '{ "total": bigint | null; }');
    strict.ok(
      dialect
        .analyze("UPDATE account SET email = event.value FROM event RETURNING event.value", schema)
        .diagnostics.some(({ code }) => code === "TSQ103"),
    );
    strict.ok(
      dialect
        .analyze("UPDATE account SET email = other.email FROM account other WHERE id = id", schema)
        .diagnostics.some(({ code }) => code === "TSQ102"),
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
      dialect.analyze("UPDATE account SET normalized = ?", schema).diagnostics.some(({ code }) => code === "TSQ218"),
    );
    strict.strictEqual(
      dialect.analyze(
        "WITH RECURSIVE tree(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM tree) SEARCH DEPTH FIRST BY id SET traversal SELECT id FROM tree",
        schema,
      ).diagnostics[0]?.code,
      "TSQ001",
    );
    for (const postgresFromSyntax of [
      "SELECT * FROM ROWS FROM (generate_series(1, 2)) AS values(value)",
      "SELECT id FROM account TABLESAMPLE SYSTEM(10)",
    ]) {
      strict.strictEqual(dialect.analyze(postgresFromSyntax, schema).diagnostics[0]?.code, "TSQ001");
    }
  });
});
