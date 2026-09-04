// docs:start quickstart-mysql-query
import { sql } from "@typed-sql/mysql";

export const accountById = (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM users AS account
  WHERE account.id = ${accountId}
`;
// docs:end quickstart-mysql-query
