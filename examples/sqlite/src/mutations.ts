import { sql } from "@typed-sql/sqlite";

export interface NewAccount {
  readonly id: bigint;
  readonly email: string;
  readonly status: string;
}

export interface NewProject {
  readonly id: bigint;
  readonly ownerId: bigint;
  readonly name: string;
  readonly budget: number | null;
}

export const insertAccount = (account: NewAccount) => sql`
  INSERT INTO account (id, email, status)
  VALUES (${account.id}, ${account.email}, ${account.status})
  RETURNING id, email, status
`;

export const updateAccountStatus = (accountId: bigint, status: string) => sql`
  UPDATE account
  SET status = ${status}
  WHERE id = ${accountId}
  RETURNING id, email, status
`;

export const deleteAccount = (accountId: bigint) => sql`
  DELETE FROM account
  WHERE id = ${accountId}
  RETURNING id, email, status
`;

export const insertProject = (project: NewProject) => sql`
  INSERT INTO project (id, owner_id, name, budget)
  VALUES (${project.id}, ${project.ownerId}, ${project.name}, ${project.budget})
  RETURNING id, owner_id, name, budget
`;

export const deleteProjectsByOwner = (ownerId: bigint) => sql`
  DELETE FROM project
  WHERE owner_id = ${ownerId}
`;
