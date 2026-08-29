import { renderQuery } from "@typed-sql/core";
import { postgresRenderer } from "@typed-sql/postgres/runtime";
import { describe, it, strict } from "poku";
import { accounts } from "../src/queries.js";

await describe("PostgreSQL example", async () => {
  await it("composes selected columns, joins, and ordered parameters", () => {
    const rendered = renderQuery(
      accounts({ status: "active", minimumId: 7n }, { status: true, projectBudget: true }),
      postgresRenderer,
    );

    strict.match(rendered.text, /account\.status/u);
    strict.match(rendered.text, /LEFT JOIN projects/u);
    strict.match(rendered.text, /account\.status = \$1/u);
    strict.match(rendered.text, /account\.id >= \$2/u);
    strict.deepStrictEqual(rendered.values, ["active", 7n]);
  });

  await it("omits optional structure without leaving parameters behind", () => {
    const rendered = renderQuery(accounts({}, { status: false, projectBudget: false }), postgresRenderer);

    strict.doesNotMatch(rendered.text, /account\.status|JOIN projects|project\.budget/u);
    strict.deepStrictEqual(rendered.values, []);
  });
});
