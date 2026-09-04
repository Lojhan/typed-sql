import type { QueryParameters } from "@typed-sql/core";

// docs:start postgres-multi-row-insert
import { sql } from "@typed-sql/postgres";

export interface NewUser {
  readonly id: bigint;
  readonly email: string;
  readonly status: "active" | "suspended";
}

export function insertUsers(items: readonly NewUser[]) {
  if (items.length === 0) throw new RangeError("insertUsers requires at least one item");

  return sql`
    INSERT INTO users (id, email, status)
    VALUES ${items.map((item) => sql.fragment`(${item.id}, ${item.email}, ${item.status})`)}
    RETURNING id, email, status
  `;
}
// docs:end postgres-multi-row-insert

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;
const parameterContract: Assert<Equal<QueryParameters<ReturnType<typeof insertUsers>>, readonly (string | bigint)[]>> =
  true;
void parameterContract;
