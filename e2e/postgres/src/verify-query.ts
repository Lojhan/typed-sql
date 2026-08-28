import { sql } from "@typed-sql/postgres";

export const accountVerificationQuery = sql`
  SELECT users.id, users.email
  FROM users
  WHERE users.id >= ${1n}
`;
