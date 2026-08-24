import { sql } from "@typed-sql/postgres";

export const secondQuery = sql`
  SELECT age.user_id
  FROM ages AS age
`;
