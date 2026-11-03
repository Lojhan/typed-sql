import type { QueryParameters, QueryRow } from "@typed-sql/core";
import { sql } from "@typed-sql/mysql";

export interface AccountFilters {
  readonly status?: "active" | "suspended" | null;
  readonly minimumId?: bigint | null;
}

export interface AccountSelect {
  readonly status: boolean;
  readonly orderTotal: boolean;
}

export function accounts<const Select extends AccountSelect>(filters: AccountFilters, select: Select) {
  return sql`
    SELECT
      account.id,
      account.email
      ${select.status ? sql.fragment`, account.status` : sql.empty}
      ${select.orderTotal ? sql.fragment`, purchase.total_cents` : sql.empty}
    FROM users AS account
      ${select.orderTotal ? sql.fragment`LEFT JOIN orders AS purchase ON purchase.user_id = account.id` : sql.empty}
    WHERE 1 = 1
      ${filters.status == null ? sql.empty : sql.fragment`AND account.status = ${filters.status}`}
      ${filters.minimumId == null ? sql.empty : sql.fragment`AND account.id >= ${filters.minimumId}`}
    ORDER BY account.id
  `;
}

export const activeAccounts = accounts({ status: "active", minimumId: 1n }, { status: true, orderTotal: true });

export const accountById = (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM users AS account
  WHERE account.id = ${accountId}
`;

export const ordersByCustomer = (userId: bigint) => sql`
  SELECT purchase.id, purchase.user_id, purchase.status, purchase.total_cents
  FROM orders AS purchase
  WHERE purchase.user_id = ${userId}
  ORDER BY purchase.id
`;

export const accountOrderSummary = sql`
  WITH order_totals AS (
    SELECT
      purchase.user_id,
      COUNT(*) AS order_count,
      SUM(purchase.total_cents) AS total_cents
    FROM orders AS purchase
    GROUP BY purchase.user_id
  )
  SELECT
    account.id,
    account.email,
    account.status,
    order_totals.order_count,
    order_totals.total_cents
  FROM users AS account
  LEFT JOIN order_totals ON order_totals.user_id = account.id
  ORDER BY account.id
`;

export type ActiveAccount = QueryRow<typeof activeAccounts>;
export type ActiveAccountParameters = QueryParameters<typeof activeAccounts>;
