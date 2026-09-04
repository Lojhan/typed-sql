import { hasQueryResultValidator, renderQuery } from "@typed-sql/core";
import { postgresRenderer } from "@typed-sql/postgres/runtime";
import { describe, it, strict } from "poku";
import { accountById as documentedAccountById } from "../src/documentation.js";
import { insertAccount } from "../src/mutations.js";
import { accountProjectSummary, accounts } from "../src/queries.js";
import { validatedAccountById } from "../src/validation.js";

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

  await it("renders a typed mutation and a parameter-free CTE", () => {
    const mutation = renderQuery(
      insertAccount({ id: 7n, email: "seven@example.com", status: "active" }),
      postgresRenderer,
    );
    strict.match(mutation.text, /INSERT INTO users/u);
    strict.match(mutation.text, /RETURNING id, email, status/u);
    strict.deepStrictEqual(mutation.values, [7n, "seven@example.com", "active"]);

    const cte = renderQuery(accountProjectSummary, postgresRenderer);
    strict.match(cte.text, /WITH project_totals AS/u);
    strict.deepStrictEqual(cte.values, []);
  });

  await it("keeps the documented homepage query executable", () => {
    const query = renderQuery(documentedAccountById(7n), postgresRenderer);
    strict.match(query.text, /SELECT account\.id, account\.email, account\.status/u);
    strict.match(query.text, /account\.id = \$1/u);
    strict.deepStrictEqual(query.values, [7n]);
  });

  await it("attaches an application-owned Standard Schema validator immutably", () => {
    strict.strictEqual(hasQueryResultValidator(validatedAccountById(1n)), true);
  });
});
