import { DatabaseSync } from "node:sqlite";
import { describe, it, strict } from "poku";
import { nodeSqlite } from "../src/node-sqlite.js";

await describe("SQLite schema provider", async () => {
  await it("introspects strict/flexible tables, views, generated columns, indexes, and foreign keys", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE account (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          normalized TEXT GENERATED ALWAYS AS (lower(email)) STORED
        ) STRICT;
        CREATE TABLE event (
          id INTEGER PRIMARY KEY,
          account_id INTEGER REFERENCES account(id) ON DELETE CASCADE,
          payload JSON
        );
        CREATE INDEX event_account_idx ON event(account_id) WHERE account_id IS NOT NULL;
        CREATE VIEW account_view AS SELECT id, email FROM account;
      `);
      const snapshot = await nodeSqlite({ database }).introspect();
      strict.strictEqual(snapshot.tables.account?.strict, true);
      strict.strictEqual(snapshot.tables.account?.columns.id?.tsType, "bigint");
      strict.strictEqual(snapshot.tables.account?.columns.normalized?.generated, "stored");
      strict.strictEqual(snapshot.tables.event?.strict, false);
      strict.ok(snapshot.tables.event?.columns.payload?.tsType.includes("Uint8Array"));
      strict.strictEqual(snapshot.tables.event?.indexes[0]?.partial, true);
      strict.strictEqual(snapshot.tables.event?.foreignKeys[0]?.referencedTable, "account");
      strict.strictEqual(snapshot.tables.account_view?.kind, "view");
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
        CREATE UNIQUE INDEX child_label_idx ON child(lower(label) DESC) WHERE label IS NOT NULL;
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
      strict.deepStrictEqual(expressionIndex?.columns, [{ expression: true, descending: true }]);
      strict.strictEqual(snapshot.tables["tenant.project"]?.strict, true);
      strict.strictEqual(snapshot.functions?.["slug/1"]?.returnType, "string");
      await strict.rejects(nodeSqlite({ database, schemas: [] }).introspect(), /at least one schema/);
    } finally {
      database.close();
    }
  });
});
