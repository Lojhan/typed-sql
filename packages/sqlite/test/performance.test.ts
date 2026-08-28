import { measureGrammarPerformance } from "@typed-sql/conformance";
import { describe, it, strict } from "poku";
import { type SqliteSchemaSnapshot, sqlite } from "../src/index.js";

const snapshot = {
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
      },
    },
  },
} as const satisfies SqliteSchemaSnapshot;

await describe("SQLite grammar performance", async () => {
  await it("keeps parser and resolver throughput above the preview floor", () => {
    const result = measureGrammarPerformance({
      dialect: sqlite(),
      snapshot,
      queries: [
        "SELECT id, email FROM account WHERE id = ?",
        "SELECT left_account.id, right_account.score FROM account left_account LEFT JOIN account right_account ON left_account.id = right_account.id",
        "WITH selected AS (SELECT id, email FROM account) SELECT id, email FROM selected",
        "INSERT INTO account (id, email) VALUES (?, ?) RETURNING id, email",
        "SELECT id FROM account UNION ALL SELECT id FROM account",
      ],
      warmups: 5,
      samples: 30,
    });
    strict.ok(result.minimumQueriesPerSecond >= 1_000, JSON.stringify(result));
    strict.ok(result.p95Milliseconds < 25, JSON.stringify(result));
  });
});
