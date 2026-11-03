import { sql } from "@typed-sql/sqlite";

export interface NewAccount {
  readonly id: bigint;
  readonly email: string;
  readonly status: string;
}

export interface NewOrder {
  readonly id: bigint;
  readonly userId: bigint;
  readonly status: "draft" | "paid" | "shipped" | "cancelled";
  readonly totalCents: bigint;
}

export const insertAccount = (account: NewAccount) => sql`
  INSERT INTO users (id, email, status)
  VALUES (${account.id}, ${account.email}, ${account.status})
  RETURNING id, email, status
`;

export const updateAccountStatus = (accountId: bigint, status: string) => sql`
  UPDATE users
  SET status = ${status}
  WHERE id = ${accountId}
  RETURNING id, email, status
`;

export const deleteAccount = (accountId: bigint) => sql`
  DELETE FROM users AS account
  WHERE id = ${accountId}
  RETURNING id, email, status
`;

export const insertOrder = (purchase: NewOrder) => sql`
  INSERT INTO orders (id, user_id, status, total_cents)
  VALUES (${purchase.id}, ${purchase.userId}, ${purchase.status}, ${purchase.totalCents})
  RETURNING id, user_id, status, total_cents
`;

export const deleteOrdersByCustomer = (userId: bigint) => sql`
  DELETE FROM orders
  WHERE user_id = ${userId}
`;
