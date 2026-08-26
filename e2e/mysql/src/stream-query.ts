import { sql } from "@typed-sql/mysql";

export const streamAccountsQuery = sql`
  SELECT user_account.id,
         user_account.email,
         user_account.status,
         project.budget
  FROM users AS user_account
  LEFT JOIN projects AS project ON user_account.id = project.owner_id
  ORDER BY user_account.id
`;
