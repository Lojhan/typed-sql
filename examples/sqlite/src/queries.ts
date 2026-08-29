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

export const accountById = (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM account
  WHERE account.id = ${accountId}
`;

export const projectsByOwner = (ownerId: bigint) => sql`
  SELECT project.id, project.owner_id, project.name, project.budget
  FROM project
  WHERE project.owner_id = ${ownerId}
  ORDER BY project.id
`;

export const accountProjectSummary = sql`
  WITH project_totals AS (
    SELECT
      project.owner_id,
      COUNT(*) AS project_count,
      SUM(project.budget) AS total_budget
    FROM project
    GROUP BY project.owner_id
  )
  SELECT
    account.id,
    account.email,
    account.status,
    project_totals.project_count,
    project_totals.total_budget
  FROM account
  LEFT JOIN project_totals ON project_totals.owner_id = account.id
  ORDER BY account.id
`;

export type ActiveAccount = QueryRow<typeof activeAccounts>;
export type ActiveAccountParameters = QueryParameters<typeof activeAccounts>;
