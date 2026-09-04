// docs:start homepage-postgres-query
import { sql } from "@typed-sql/postgres";

export const accountById = (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM users AS account
  WHERE account.id = ${accountId}
`;
// docs:end homepage-postgres-query
