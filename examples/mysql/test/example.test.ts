import { renderQuery } from "@typed-sql/core";
import { mysqlRenderer } from "@typed-sql/mysql/runtime";
import { describe, it, strict } from "poku";
import { accounts } from "../src/queries.js";

await describe("MySQL example", async () => {
  await it("composes selected columns, joins, and ordered parameters", () => {
    const rendered = renderQuery(
      accounts({ status: "active", minimumId: 7n }, { status: true, projectBudget: true }),
      mysqlRenderer,
    );

    strict.match(rendered.text, /account\.status/u);
    strict.match(rendered.text, /LEFT JOIN projects/u);
    strict.match(rendered.text, /account\.status = \?/u);
    strict.match(rendered.text, /account\.id >= \?/u);
    strict.deepStrictEqual(rendered.values, ["active", 7n]);
  });

  await it("omits optional structure without leaving parameters behind", () => {
    const rendered = renderQuery(accounts({}, { status: false, projectBudget: false }), mysqlRenderer);

    strict.doesNotMatch(rendered.text, /account\.status|JOIN projects|project\.budget/u);
    strict.deepStrictEqual(rendered.values, []);
  });
});
