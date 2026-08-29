import { renderQuery } from "@typed-sql/core";
import { postgresRenderer } from "@typed-sql/postgres/runtime";
import { sqliteRenderer } from "@typed-sql/sqlite/runtime";
import { describe, it, strict } from "poku";
import { customerById } from "../postgres/src/queries.js";
import { preferenceByCustomerId, updatePreference } from "../sqlite/src/queries.js";

await describe("multi-database example construction", async () => {
  await it("keeps each grammar renderer and parameter list independent", () => {
    strict.deepStrictEqual(renderQuery(customerById(7n), postgresRenderer).values, [7n]);
    strict.deepStrictEqual(renderQuery(preferenceByCustomerId(7n), sqliteRenderer).values, [7n]);
    strict.deepStrictEqual(renderQuery(updatePreference(7n, "dark", 1n), sqliteRenderer).values, ["dark", 1n, 7n]);
    strict.match(renderQuery(customerById(7n), postgresRenderer).text, /\$1/u);
    strict.match(renderQuery(preferenceByCustomerId(7n), sqliteRenderer).text, /\?/u);
  });
});
