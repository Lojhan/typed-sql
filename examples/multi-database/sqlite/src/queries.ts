import { sql } from "@typed-sql/sqlite";
export const profileByUserId = (userId: bigint) => sql`
  SELECT id, profile FROM users WHERE id = ${userId}
`;
export const updateProfile = (userId: bigint, profile: string) => sql`
  UPDATE users SET profile = ${profile} WHERE id = ${userId}
  RETURNING id, profile
`;
