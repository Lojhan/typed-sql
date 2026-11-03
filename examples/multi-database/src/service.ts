import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import type { SqliteDatabase } from "@typed-sql/sqlite/runtime";
import { userById } from "../postgres/src/queries.js";
import { profileByUserId, updateProfile } from "../sqlite/src/queries.js";

export interface Databases {
  readonly postgres: PostgresDatabase;
  readonly sqlite: SqliteDatabase;
}

export async function getUserProfile(databases: Databases, userId: bigint) {
  const [user, profile] = await Promise.all([
    databases.postgres.maybeOne(userById(userId)),
    databases.sqlite.maybeOne(profileByUserId(userId)),
  ]);
  return { user, profile };
}

export async function setUserProfile(
  databases: Databases,
  userId: bigint,
  theme: "light" | "dark",
  emailNotifications: boolean,
) {
  // This is intentionally a SQLite transaction only. typed-sql does not imply a
  // distributed transaction across unrelated drivers.
  return databases.sqlite.transaction((transaction) =>
    transaction.one(updateProfile(userId, JSON.stringify({ theme, emailNotifications }))),
  );
}
