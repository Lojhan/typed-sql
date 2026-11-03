import { hasQueryResultValidator, renderQuery } from "@typed-sql/core";
import { sqliteRenderer } from "@typed-sql/sqlite/runtime";
import { describe, it, strict } from "poku";
import { accountById as documentedAccountById } from "../src/documentation.js";
import { insertAccount } from "../src/mutations.js";
import { accountOrderSummary, accounts } from "../src/queries.js";
import { validatedAccountById } from "../src/validation.js";

await describe("SQLite example", async () => {
  await it("composes selected columns, joins, and ordered parameters", () => {
    const rendered = renderQuery(
      accounts({ status: "active", minimumId: 7n }, { status: true, orderTotal: true }),
      sqliteRenderer,
    );

    strict.match(rendered.text, /account\.status/u);
    strict.match(rendered.text, /LEFT JOIN orders/u);
    strict.match(rendered.text, /account\.status = \?/u);
    strict.match(rendered.text, /account\.id >= \?/u);
    strict.deepStrictEqual(rendered.values, ["active", 7n]);
  });

  await it("omits optional structure without leaving parameters behind", () => {
    const rendered = renderQuery(accounts({}, { status: false, orderTotal: false }), sqliteRenderer);

    strict.doesNotMatch(rendered.text, /account\.status|JOIN orders|purchase\.total_cents/u);
    strict.deepStrictEqual(rendered.values, []);
  });

  await it("renders a typed mutation and a parameter-free CTE", () => {
    const mutation = renderQuery(
      insertAccount({ id: 7n, email: "seven@example.com", status: "active" }),
      sqliteRenderer,
    );
    strict.match(mutation.text, /INSERT INTO users/u);
    strict.match(mutation.text, /RETURNING id, email, status/u);
    strict.deepStrictEqual(mutation.values, [7n, "seven@example.com", "active"]);

    const cte = renderQuery(accountOrderSummary, sqliteRenderer);
    strict.match(cte.text, /WITH order_totals AS/u);
    strict.deepStrictEqual(cte.values, []);
  });

  await it("keeps the documented quickstart query executable", () => {
    const query = renderQuery(documentedAccountById(7n), sqliteRenderer);
    strict.match(query.text, /SELECT account\.id, account\.email, account\.status/u);
    strict.match(query.text, /account\.id = \?/u);
    strict.deepStrictEqual(query.values, [7n]);
  });

  await it("attaches an application-owned Standard Schema validator immutably", () => {
    strict.strictEqual(hasQueryResultValidator(validatedAccountById(1n)), true);
  });
});
