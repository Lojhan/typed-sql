import { sql } from "@typed-sql/sqlserver";
export const accountById = (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM dbo.users AS account
  WHERE account.id = ${accountId}
`;
export const repeated = (ids: readonly bigint[]) =>
  sql`SELECT id FROM dbo.orders WHERE id IN (${ids.map((id) => sql.fragment`${id}`)}) ORDER BY id`;
export const conditional = (amount: boolean) =>
  sql`SELECT id${amount ? sql.fragment`,amount` : sql.empty} FROM dbo.orders WHERE id=${9001n}`;
