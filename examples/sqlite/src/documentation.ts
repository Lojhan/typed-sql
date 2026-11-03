// docs:start quickstart-sqlite-query
import { sql } from "@typed-sql/sqlite";

export const accountById = (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM users AS account
  WHERE account.id = ${accountId}
`;
// docs:end quickstart-sqlite-query
