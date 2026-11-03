import { renderQuery } from "@typed-sql/core";
import { postgresRenderer } from "@typed-sql/postgres/runtime";
import { sqliteRenderer } from "@typed-sql/sqlite/runtime";
import { describe, it, strict } from "poku";
import { userById } from "../postgres/src/queries.js";
import { profileByUserId, updateProfile } from "../sqlite/src/queries.js";

await describe("multi-database example construction", async () => {
  await it("keeps each grammar renderer and parameter list independent", () => {
    strict.deepStrictEqual(renderQuery(userById(7n), postgresRenderer).values, [7n]);
    strict.deepStrictEqual(renderQuery(profileByUserId(7n), sqliteRenderer).values, [7n]);
    strict.deepStrictEqual(
      renderQuery(updateProfile(7n, '{"theme":"dark","emailNotifications":true}'), sqliteRenderer).values,
      ['{"theme":"dark","emailNotifications":true}', 7n],
    );
    strict.match(renderQuery(userById(7n), postgresRenderer).text, /\$1/u);
    strict.match(renderQuery(profileByUserId(7n), sqliteRenderer).text, /\?/u);
  });
});
