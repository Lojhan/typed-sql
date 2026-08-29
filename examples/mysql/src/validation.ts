import { sql } from "@typed-sql/mysql";
import * as v from "valibot";

export const accountResult = v.object({
  id: v.bigint(),
  email: v.pipe(v.string(), v.email()),
  status: v.picklist(["active", "suspended"]),
});

interface ValidatedAccount {
  readonly id: bigint;
  readonly email: string;
  readonly status: "active" | "suspended";
}

export const validatedAccountById = (accountId: bigint) =>
  sql.validateResult(
    sql<ValidatedAccount>`
      SELECT account.id, account.email, account.status
      FROM users AS account
      WHERE account.id = ${accountId}
    `,
    accountResult,
  );
