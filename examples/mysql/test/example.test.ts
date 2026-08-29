import { hasQueryResultValidator, renderQuery } from "@typed-sql/core";
import { mysqlRenderer } from "@typed-sql/mysql/runtime";
import { describe, it, strict } from "poku";
import { insertAccount } from "../src/mutations.js";
import { accountProjectSummary, accounts } from "../src/queries.js";
import { validatedAccountById } from "../src/validation.js";

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

  await it("renders a typed mutation and a parameter-free CTE", () => {
    const mutation = renderQuery(
      insertAccount({ id: 7n, email: "seven@example.com", status: "active" }),
      mysqlRenderer,
    );
    strict.match(mutation.text, /INSERT INTO users/u);
    strict.deepStrictEqual(mutation.values, [7n, "seven@example.com", "active"]);

    const cte = renderQuery(accountProjectSummary, mysqlRenderer);
    strict.match(cte.text, /WITH project_totals AS/u);
    strict.deepStrictEqual(cte.values, []);
  });

  await it("attaches an application-owned Standard Schema validator immutably", () => {
    strict.strictEqual(hasQueryResultValidator(validatedAccountById(1n)), true);
  });
});
