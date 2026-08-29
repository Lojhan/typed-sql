import { sql } from "@typed-sql/postgres";

export interface NewAccount {
  readonly id: bigint;
  readonly email: string;
  readonly status: "active" | "suspended";
}

export interface NewProject {
  readonly id: bigint;
  readonly ownerId: bigint;
  readonly name: string;
  readonly budget: string | null;
}

export const insertAccount = (account: NewAccount) => sql`
  INSERT INTO users (id, email, status)
  VALUES (${account.id}, ${account.email}, ${account.status}::account_status)
  RETURNING id, email, status
`;

export const updateAccountStatus = (accountId: bigint, status: NewAccount["status"]) => sql`
  UPDATE users
  SET status = ${status}::account_status
  WHERE id = ${accountId}
  RETURNING id, email, status
`;

export const deleteAccount = (accountId: bigint) => sql`
  DELETE FROM users
  WHERE id = ${accountId}
  RETURNING id, email, status
`;

export const insertProject = (project: NewProject) => sql`
  INSERT INTO projects (id, owner_id, name, budget)
  VALUES (${project.id}, ${project.ownerId}, ${project.name}, ${project.budget})
  RETURNING id, owner_id, name, budget
`;

export const deleteProjectsByOwner = (ownerId: bigint) => sql`
  DELETE FROM projects
  WHERE owner_id = ${ownerId}
`;

/** The plain, one-row INSERT shape required by PostgreSQL COPY FROM. */
export const bulkAccountInsert = (account: NewAccount) => sql`
  INSERT INTO users (id, email, status)
  VALUES (${account.id}, ${account.email}, ${account.status})
`;
