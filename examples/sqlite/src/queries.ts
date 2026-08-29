import type { QueryParameters, QueryRow } from "@typed-sql/core";
import { sql } from "@typed-sql/sqlite";

export interface AccountFilters {
  readonly status?: string | null;
  readonly minimumId?: bigint | null;
}

export interface AccountSelect {
  readonly status: boolean;
  readonly projectBudget: boolean;
}

export function accounts<const Select extends AccountSelect>(filters: AccountFilters, select: Select) {
  return sql`
    SELECT
      account.id,
      account.email
      ${select.status ? sql.fragment`, account.status` : sql.empty}
      ${select.projectBudget ? sql.fragment`, project.budget` : sql.empty}
    FROM account
      ${select.projectBudget ? sql.fragment`LEFT JOIN project ON project.owner_id = account.id` : sql.empty}
    WHERE 1 = 1
      ${filters.status == null ? sql.empty : sql.fragment`AND account.status = ${filters.status}`}
      ${filters.minimumId == null ? sql.empty : sql.fragment`AND account.id >= ${filters.minimumId}`}
    ORDER BY account.id
  `;
}

export const activeAccounts = accounts({ status: "active", minimumId: 1n }, { status: true, projectBudget: true });

export type ActiveAccount = QueryRow<typeof activeAccounts>;
export type ActiveAccountParameters = QueryParameters<typeof activeAccounts>;
