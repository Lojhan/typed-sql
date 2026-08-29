import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import type { SqliteDatabase } from "@typed-sql/sqlite/runtime";
import { customerById } from "../postgres/src/queries.js";
import { preferenceByCustomerId, updatePreference } from "../sqlite/src/queries.js";

export interface Databases {
  readonly postgres: PostgresDatabase;
  readonly sqlite: SqliteDatabase;
}

export async function getCustomerProfile(databases: Databases, customerId: bigint) {
  const [customer, preference] = await Promise.all([
    databases.postgres.maybeOne(customerById(customerId)),
    databases.sqlite.maybeOne(preferenceByCustomerId(customerId)),
  ]);
  return { customer, preference };
}

export async function setCustomerPreference(
  databases: Databases,
  customerId: bigint,
  theme: "light" | "dark",
  emailNotifications: boolean,
) {
  // This is intentionally a SQLite transaction only. typed-sql does not imply a
  // distributed transaction across unrelated drivers.
  return databases.sqlite.transaction((transaction) =>
    transaction.one(updatePreference(customerId, theme, emailNotifications ? 1n : 0n)),
  );
}
