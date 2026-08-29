import { sql } from "@typed-sql/sqlite";
import * as v from "valibot";

export const accountResult = v.object({
  id: v.bigint(),
  email: v.pipe(v.string(), v.email()),
  status: v.string(),
});

interface ValidatedAccount {
  readonly id: bigint;
  readonly email: string;
  readonly status: string;
}

export const validatedAccountById = (accountId: bigint) =>
  sql.validateResult(
    sql<ValidatedAccount>`
      SELECT account.id, account.email, account.status
      FROM account
      WHERE account.id = ${accountId}
    `,
    accountResult,
  );
