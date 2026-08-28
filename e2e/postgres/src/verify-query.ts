import { sql } from "@typed-sql/postgres";

export const accountVerificationQuery = sql`
  SELECT users.id, users.email
  FROM users
  WHERE users.id >= ${1n}
`;

export const accountPlanMutation = sql`
  UPDATE users SET email = ${"must-not-persist@example.com"} WHERE users.id = ${1n}
`;
