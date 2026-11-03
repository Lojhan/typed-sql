import { sql } from "@typed-sql/mysql";

export interface NewAccount {
  readonly id: bigint;
  readonly email: string;
  readonly status: "active" | "suspended";
}

export interface NewOrder {
  readonly id: bigint;
  readonly userId: bigint;
  readonly status: "draft" | "paid" | "shipped" | "cancelled";
  readonly totalCents: number;
}

export const insertAccount = (account: NewAccount) => sql`
  INSERT INTO users (id, email, status)
  VALUES (${account.id}, ${account.email}, ${account.status})
`;

export const updateAccountStatus = (accountId: bigint, status: NewAccount["status"]) => sql`
  UPDATE users
  SET status = ${status}
  WHERE id = ${accountId}
`;

export const deleteAccount = (accountId: bigint) => sql`
  DELETE FROM users
  WHERE id = ${accountId}
`;

export const insertOrder = (purchase: NewOrder) => sql`
  INSERT INTO orders (id, user_id, status, total_cents)
  VALUES (${purchase.id}, ${purchase.userId}, ${purchase.status}, ${purchase.totalCents})
`;

export const deleteOrdersByCustomer = (userId: bigint) => sql`
  DELETE FROM orders
  WHERE user_id = ${userId}
`;

/** The plain, one-row INSERT shape required by MySQL LOAD DATA. */
export const bulkAccountInsert = (account: NewAccount) => sql`
  INSERT INTO users (id, email, status)
  VALUES (${account.id}, ${account.email}, ${account.status})
`;
