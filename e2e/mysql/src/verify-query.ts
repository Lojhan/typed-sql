import { sql } from "@typed-sql/mysql";

export function accountVerificationQuery(status: "active" | "suspended") {
  return sql`
    SELECT users.id, users.email, users.status
    FROM users
    WHERE users.status = ${status} AND users.id >= ${1n}
  `;
}

export const accountPlanMutation = sql`
  UPDATE users SET email = ${"must-not-persist@example.com"} WHERE users.id = ${1n}
`;
