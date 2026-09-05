import { measureGrammarPerformance } from "@typed-sql/conformance";
import { describe, it, strict } from "poku";
import { type SqliteSchemaSnapshot, sqlite } from "../src/index.js";
import { accountTable } from "./helpers/schema.js";

const snapshot = {
  formatVersion: 1,
  dialect: "sqlite",
  dialectVersion: "1.0.0",
  tables: {
    account: accountTable(),
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
    // Individual batches are short enough for other jobs on a shared CI runner to preempt
    // several samples. The median still catches sustained regressions, while the p95 ceiling
    // allows an occasional scheduler delay without making the package suite flaky.
    const medianQueriesPerSecond = (result.queryCount * 1_000) / result.p50Milliseconds;
    strict.ok(medianQueriesPerSecond >= 500, JSON.stringify({ ...result, medianQueriesPerSecond }));
    strict.ok(result.p95Milliseconds < 40, JSON.stringify(result));
  });
});
