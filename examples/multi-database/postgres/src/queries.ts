import { sql } from "@typed-sql/postgres";
export const userById = (userId: bigint) => sql`
  SELECT id, email, display_name FROM users WHERE id = ${userId}
`;
