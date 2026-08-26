import { sql } from "@typed-sql/postgres";

export const postgresAccountStream = sql`
  SELECT user_account.id,
         user_account.email,
         user_account.status,
         project.budget::NUMERIC AS budget
  FROM users AS user_account
  LEFT JOIN projects AS project ON user_account.id = project.owner_id
  ORDER BY user_account.id
`;

export const postgresAccountsAtOrAbove = (minimumId: bigint) => sql`
  SELECT user_account.id,
         user_account.email,
         user_account.status
  FROM users AS user_account
  WHERE user_account.id >= ${minimumId}
  ORDER BY user_account.id
`;
