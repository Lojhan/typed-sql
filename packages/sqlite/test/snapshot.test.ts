import { describe, it, strict } from "poku";
import {
  isKnownSqliteType,
  isKnownStrictSqliteType,
  mapSqliteCastType,
  mapSqliteType,
  parseSqliteSchemaSnapshot,
  sqliteFlexibleType,
} from "../src/index.js";

const valid = {
  formatVersion: 1,
  dialect: "sqlite",
  tables: {
    account: {
      name: "account",
      columns: {
        id: { name: "id", databaseType: "INTEGER", tsType: "bigint", nullable: false },
      },
      indexes: [
        {
          name: "account_id",
          unique: true,
          partial: false,
          origin: "primary-key",
          columns: [{ name: "id", expression: false, descending: false }],
        },
      ],
      foreignKeys: [
        {
          columns: ["id"],
          referencedTable: "parent",
          referencedColumns: ["id"],
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
        },
      ],
    },
  },
};

function changed(path: readonly (string | number)[], value: unknown): unknown {
  const copy = structuredClone(valid) as unknown;
  let current = copy as Record<string | number, unknown>;
  for (const part of path.slice(0, -1)) current = current[part] as Record<string | number, unknown>;
  current[path.at(-1)!] = value;
  return copy;
}

await describe("SQLite snapshot and type policy", async () => {
  await it("normalizes optional SQLite metadata", () => {
    const snapshot = parseSqliteSchemaSnapshot(valid);
    strict.strictEqual(snapshot.tables.account?.schema, "main");
    strict.strictEqual(snapshot.tables.account?.kind, "table");
    strict.strictEqual(snapshot.tables.account?.strict, false);
    strict.strictEqual(snapshot.tables.account?.withoutRowid, false);
    strict.deepStrictEqual(snapshot.tables.account?.indexes[0]?.columns[0], {
      name: "id",
      expression: false,
      descending: false,
    });
  });

  await it("validates every SQLite-owned snapshot boundary", () => {
    const cases: readonly [readonly (string | number)[], unknown, RegExp][] = [
      [["dialect"], "postgres", /cannot use a postgres/],
      [["tables", "account", "schema"], 1, /schema must be a string/],
      [["tables", "account", "kind"], "shadow", /kind must be table, view, or virtual/],
      [["tables", "account", "strict"], "yes", /strict must be a boolean/],
      [["tables", "account", "withoutRowid"], 1, /withoutRowid must be a boolean/],
      [["tables", "account", "columns", "id"], "invalid", /must be an object/],
      [["tables", "account", "columns", "id", "generated"], "dynamic", /generated must be virtual or stored/],
      [["tables", "account", "columns", "id", "hidden"], 1, /hidden must be a boolean/],
      [["tables", "account", "columns", "id", "primaryKeyPosition"], -1, /must be non-negative/],
      [["tables", "account", "indexes"], {}, /indexes must be an array/],
      [["tables", "account", "indexes", 0], "invalid", /must be an object/],
      [["tables", "account", "indexes", 0, "name"], 1, /name must be a string/],
      [["tables", "account", "indexes", 0, "unique"], 1, /unique must be a boolean/],
      [["tables", "account", "indexes", 0, "partial"], 1, /partial must be a boolean/],
      [["tables", "account", "indexes", 0, "origin"], "other", /origin must be create, unique, or primary-key/],
      [["tables", "account", "indexes", 0, "columns"], {}, /columns must be an array/],
      [["tables", "account", "indexes", 0, "columns", 0], "invalid", /must be an object/],
      [["tables", "account", "indexes", 0, "columns", 0, "name"], 1, /name must be a string/],
      [["tables", "account", "indexes", 0, "columns", 0, "expression"], 1, /expression must be a boolean/],
      [["tables", "account", "indexes", 0, "columns", 0, "descending"], 1, /descending must be a boolean/],
      [["tables", "account", "foreignKeys"], {}, /foreignKeys must be an array/],
      [["tables", "account", "foreignKeys", 0], "invalid", /must be an object/],
      [["tables", "account", "foreignKeys", 0, "columns"], [1], /must be a string array/],
      [["tables", "account", "foreignKeys", 0, "referencedTable"], 1, /must be a string/],
      [["tables", "account", "foreignKeys", 0, "referencedColumns"], [1], /must be a string array/],
      [["tables", "account", "foreignKeys", 0, "onUpdate"], 1, /must be a string/],
      [["tables", "account", "foreignKeys", 0, "onDelete"], 1, /must be a string/],
    ];
    for (const [path, value, message] of cases) {
      strict.throws(() => parseSqliteSchemaSnapshot(changed(path, value)), message, path.join("."));
    }
  });

  await it("maps strict, flexible, cast, domain, and unknown types explicitly", () => {
    const bigintPolicy = { integer: "bigint", flexible: "union", unknown: "unknown" } as const;
    const numberPolicy = { integer: "number", flexible: "unknown", unknown: "never" } as const;
    strict.strictEqual(isKnownStrictSqliteType(" integer "), true);
    strict.strictEqual(isKnownStrictSqliteType("varchar"), false);
    strict.strictEqual(isKnownSqliteType(""), false);
    strict.strictEqual(isKnownSqliteType("JSON"), true);
    strict.strictEqual(sqliteFlexibleType(numberPolicy), "unknown");
    strict.strictEqual(sqliteFlexibleType(bigintPolicy), "bigint | number | string | Uint8Array");
    strict.strictEqual(mapSqliteType("INT", bigintPolicy, { strict: true }), "bigint");
    strict.strictEqual(mapSqliteType("REAL", bigintPolicy, { strict: true }), "number");
    strict.strictEqual(mapSqliteType("TEXT", bigintPolicy, { strict: true }), "string");
    strict.strictEqual(mapSqliteType("BLOB", bigintPolicy, { strict: true }), "Uint8Array");
    strict.strictEqual(mapSqliteType("ANY", bigintPolicy, { strict: true }), "bigint | number | string | Uint8Array");
    strict.strictEqual(
      mapSqliteType("money", bigintPolicy, {
        strict: true,
        schema: {
          formatVersion: 1,
          dialect: "sqlite",
          tables: {},
          domains: { money: { name: "money", databaseType: "money", tsType: "Money", nullable: false } },
        },
      }),
      "Money",
    );
    strict.strictEqual(mapSqliteType("missing", numberPolicy, { strict: true }), "never");
    strict.strictEqual(mapSqliteCastType("INTEGER", bigintPolicy), "bigint");
    strict.strictEqual(mapSqliteCastType("REAL", bigintPolicy), "number");
    strict.strictEqual(mapSqliteCastType("TEXT", bigintPolicy), "string");
    strict.strictEqual(mapSqliteCastType("BLOB", bigintPolicy), "Uint8Array");
    strict.strictEqual(mapSqliteCastType("NUMERIC", bigintPolicy), "bigint | number");
  });
});
