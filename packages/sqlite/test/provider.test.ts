import { DatabaseSync } from "node:sqlite";
import { parameterTypeLiteral, rowTypeLiteral } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { calculateSchemaHash, fingerprintSchemaExpression, serializeSchemaSnapshot } from "../../schema/src/index.js";
import { parseSqliteSchemaSnapshot, sqlite } from "../src/index.js";
import { nodeSqlite } from "../src/node-sqlite.js";
import { type SqliteQueryable, SqliteSchemaProvider } from "../src/provider.js";

function queryable(database: DatabaseSync, reverse: boolean): SqliteQueryable {
  return {
    all<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): readonly Row[] {
      if (values.length > 0) throw new TypeError("Canonical introspection fixture does not accept parameters");
      const rows = database.prepare(sql).all() as unknown as readonly Row[];
      return reverse ? [...rows].reverse() : rows;
    },
  };
}

await describe("SQLite schema provider", async () => {
  await it("introspects strict/flexible tables, views, generated columns, indexes, and foreign keys", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE account (
          id INTEGER PRIMARY KEY,
          email TEXT COLLATE nocase NOT NULL UNIQUE,
          score INTEGER CHECK (score >= 0),
          normalized TEXT GENERATED ALWAYS AS (lower(email)) STORED,
          CHECK (email <> '')
        ) STRICT;
        CREATE TABLE event (
          id INTEGER PRIMARY KEY,
          account_id INTEGER REFERENCES account(id) ON DELETE CASCADE,
          payload JSON
        );
        CREATE INDEX event_account_idx ON event(account_id) WHERE account_id IS NOT NULL;
        CREATE VIEW account_view AS SELECT id, email FROM account;
        CREATE TRIGGER account_email_audit AFTER UPDATE OF email ON account BEGIN SELECT NEW.email; END;
        CREATE TABLE legacy_key (code TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE descending_key (id INTEGER PRIMARY KEY DESC, value TEXT);
        CREATE VIRTUAL TABLE docs USING fts5(body);
      `);
      const snapshot = await nodeSqlite({ database }).introspect();
      strict.strictEqual(snapshot.formatVersion, 2);
      strict.strictEqual(snapshot.server?.product, "sqlite");
      strict.strictEqual(snapshot.server?.version, snapshot.version);
      strict.deepStrictEqual(snapshot.server?.features, [...(snapshot.server?.features ?? [])].sort());
      strict.strictEqual(snapshot.tables.account?.strict, true);
      strict.strictEqual(snapshot.tables.account?.columns.id?.tsType, "bigint");
      strict.strictEqual(snapshot.tables.account?.columns.normalized?.generated, "stored");
      strict.strictEqual(
        snapshot.relations.account?.columns.normalized?.generatedExpressionHash,
        fingerprintSchemaExpression("lower(email)"),
      );
      strict.strictEqual(snapshot.tables.account?.rowidAlias, "id");
      strict.strictEqual(snapshot.relations.account?.columns.id?.classification, "rowid");
      strict.strictEqual(snapshot.relations.account?.columns.id?.identity, "by-default");
      strict.strictEqual(snapshot.relations.account?.columns.normalized?.nullabilitySource, "generated");
      strict.strictEqual(snapshot.relations.account?.constraints.filter(({ kind }) => kind === "check").length, 2);
      strict.ok(
        snapshot.relations.account?.constraints
          .filter(({ kind }) => kind === "check")
          .every((constraint) => constraint.kind === "check" && constraint.predicateHash?.startsWith("sha256:")),
      );
      strict.strictEqual(snapshot.tables.legacy_key?.columns.code?.nullable, true);
      strict.strictEqual(snapshot.tables.descending_key?.rowidAlias, undefined);
      strict.strictEqual(snapshot.tables.descending_key?.columns.id?.nullable, true);
      strict.strictEqual(snapshot.tables.docs?.kind, "virtual");
      strict.strictEqual(snapshot.relations.docs?.kind, "virtual-table");
      strict.strictEqual(snapshot.relations.docs?.extension?.attributes.module, "fts5");
      strict.ok(Object.values(snapshot.tables).some(({ kind }) => kind === "shadow"));
      strict.ok(Object.values(snapshot.tables.docs?.columns ?? {}).some(({ hidden }) => hidden === true));
      const triggers = snapshot.relations.account?.extension?.attributes.triggers;
      strict.ok(Array.isArray(triggers) && triggers.length === 1);
      strict.strictEqual(snapshot.tables.event?.strict, false);
      strict.ok(snapshot.tables.event?.columns.payload?.tsType.includes("Uint8Array"));
      strict.strictEqual(snapshot.tables.event?.indexes[0]?.partial, true);
      strict.strictEqual(snapshot.tables.event?.foreignKeys[0]?.referencedTable, "account");
      strict.strictEqual(snapshot.tables.account_view?.kind, "view");
      strict.strictEqual(snapshot.relations.account_view?.kind, "view");
      strict.ok(snapshot.relations.account?.constraints.some(({ kind }) => kind === "primary-key"));
      strict.strictEqual(snapshot.relations.event?.indexes[0]?.predicate, "present");
      const roundTrip = parseSqliteSchemaSnapshot(JSON.parse(serializeSchemaSnapshot(snapshot)) as unknown);
      strict.strictEqual(roundTrip.tables.account?.strict, true);
      strict.strictEqual(roundTrip.tables.account?.columns.normalized?.generated, "stored");
      strict.strictEqual(roundTrip.tables.account?.rowidAlias, "id");
      strict.ok(
        !sqlite()
          .analyze("INSERT INTO account (email) VALUES ('next@example.com')", roundTrip)
          .diagnostics.some(({ code }) => code === "TSQ219"),
      );
      const rowid = sqlite().analyze("SELECT rowid AS internal_id FROM legacy_key", roundTrip);
      strict.deepStrictEqual(
        rowid.diagnostics.filter(({ severity }) => severity === "error"),
        [],
      );
      strict.strictEqual(rowid.columns[0]?.tsType, "bigint");
      const visibleFtsColumns = sqlite()
        .analyze("SELECT * FROM docs", roundTrip)
        .columns.map(({ name }) => name);
      strict.deepStrictEqual(visibleFtsColumns, ["body"]);
      strict.deepStrictEqual(
        sqlite()
          .analyze(
            "INSERT INTO account (email) VALUES ('next@example.com') ON CONFLICT(email COLLATE nocase) DO NOTHING",
            roundTrip,
          )
          .diagnostics.filter(({ severity }) => severity === "error"),
        [],
      );
      strict.ok(
        sqlite()
          .analyze(
            "INSERT INTO account (email) VALUES ('next@example.com') ON CONFLICT(email COLLATE binary) DO NOTHING",
            roundTrip,
          )
          .diagnostics.some(({ code }) => code === "TSQ226"),
      );
    } finally {
      database.close();
    }
  });

  await it("preserves attached schemas, composite constraints, index details, and configured functions", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        ATTACH DATABASE ':memory:' AS tenant;
        CREATE TABLE parent (
          region INTEGER NOT NULL,
          id INTEGER NOT NULL,
          PRIMARY KEY (region, id)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE child (
          region INTEGER NOT NULL,
          parent_id INTEGER NOT NULL,
          label TEXT,
          FOREIGN KEY (region, parent_id) REFERENCES parent(region, id)
            ON UPDATE CASCADE ON DELETE RESTRICT
        ) STRICT;
        CREATE UNIQUE INDEX child_label_idx ON child(lower(label) COLLATE nocase DESC) WHERE label IS NOT NULL;
        CREATE TABLE tenant.project (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
      `);
      const snapshot = await nodeSqlite({
        database,
        schemas: ["main", "tenant"],
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
        routines: {
          "application.normalize/1": {
            name: "normalize",
            kind: "scalar",
            arguments: [{ databaseType: "TEXT" }],
            result: { databaseType: "TEXT", tsType: "string", nullable: false },
            deterministic: true,
            nullInput: "strict",
          },
          "application.score_total/1": {
            name: "score_total",
            kind: "aggregate",
            arguments: [{ databaseType: "INTEGER" }],
            result: { databaseType: "INTEGER", tsType: "bigint", nullable: true },
          },
          "application.running_score/1": {
            name: "running_score",
            kind: "window",
            arguments: [{ databaseType: "INTEGER" }],
            result: { databaseType: "REAL", tsType: "number", nullable: true },
          },
        },
      }).introspect();
      strict.strictEqual(snapshot.tables["main.parent"]?.withoutRowid, true);
      strict.strictEqual(snapshot.tables["main.parent"]?.columns.region?.primaryKeyPosition, 1);
      strict.deepStrictEqual(snapshot.tables["main.child"]?.foreignKeys[0]?.columns, ["region", "parent_id"]);
      strict.deepStrictEqual(snapshot.tables["main.child"]?.foreignKeys[0]?.referencedColumns, ["region", "id"]);
      strict.strictEqual(snapshot.tables["main.child"]?.foreignKeys[0]?.onUpdate, "CASCADE");
      strict.strictEqual(snapshot.tables["main.child"]?.foreignKeys[0]?.onDelete, "RESTRICT");
      const expressionIndex = snapshot.tables["main.child"]?.indexes.find(({ name }) => name === "child_label_idx");
      strict.strictEqual(expressionIndex?.unique, true);
      strict.strictEqual(expressionIndex?.partial, true);
      strict.strictEqual(expressionIndex?.origin, "create");
      strict.deepStrictEqual(expressionIndex?.columns, [{ expression: true, descending: true, collation: "nocase" }]);
      strict.strictEqual(
        snapshot.relations["main.child"]?.indexes[0]?.columns[0]?.expressionHash,
        fingerprintSchemaExpression("lower(label)"),
      );
      strict.strictEqual(
        snapshot.relations["main.child"]?.indexes[0]?.predicateHash,
        fingerprintSchemaExpression("label IS NOT NULL"),
      );
      strict.strictEqual(snapshot.tables["tenant.project"]?.strict, true);
      strict.match(String(snapshot.namespaces.tenant?.extension?.attributes.identity), /^sha256:/u);
      strict.strictEqual(snapshot.functions?.["slug/1"]?.returnType, "string");
      strict.strictEqual(snapshot.routines.slug?.[0]?.result.kind, "scalar");
      strict.strictEqual(snapshot.routines.normalize?.[0]?.kind, "function");
      strict.strictEqual(snapshot.routines.normalize?.[0]?.deterministic, true);
      strict.strictEqual(snapshot.routines.score_total?.[0]?.kind, "aggregate");
      strict.strictEqual(snapshot.routines.running_score?.[0]?.kind, "window");
      const routines = sqlite().analyze(
        "SELECT normalize(?) AS normalized, score_total(region) AS total, running_score(region) OVER (ORDER BY id) AS running FROM main.parent",
        snapshot,
      );
      strict.deepStrictEqual(
        routines.diagnostics.filter(({ severity }) => severity === "error"),
        [],
      );
      strict.strictEqual(
        rowTypeLiteral(routines.columns),
        '{ "normalized": string; "total": bigint | null; "running": number | null; }',
      );
      strict.strictEqual(parameterTypeLiteral(1, routines.parameters), "readonly [string | null]");
      strict.ok(
        sqlite()
          .analyze("SELECT running_score(region) AS invalid FROM main.parent", snapshot)
          .diagnostics.some(({ code }) => code === "TSQ223"),
      );
      strict.ok(
        sqlite()
          .analyze("SELECT rowid AS invalid FROM main.parent", snapshot)
          .diagnostics.some(({ code }) => code === "TSQ101"),
      );
      await strict.rejects(nodeSqlite({ database, schemas: [] }).introspect(), /at least one schema/);
    } finally {
      database.close();
    }
  });

  await it("is canonical across shuffled pragma and catalog row order", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT UNIQUE) STRICT;
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER REFERENCES parent(id),
          label TEXT
        ) STRICT;
        CREATE INDEX child_label_idx ON child(label DESC) WHERE label IS NOT NULL;
      `);
      const ordered = await new SqliteSchemaProvider({ client: queryable(database, false) }).introspect();
      const shuffled = await new SqliteSchemaProvider({ client: queryable(database, true) }).introspect();
      strict.strictEqual(calculateSchemaHash(ordered), calculateSchemaHash(shuffled));
    } finally {
      database.close();
    }
  });
});
