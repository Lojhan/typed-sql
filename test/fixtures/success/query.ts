import { sql } from "@typed-sql/postgres";
import { db } from "./database.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

const query = sql`
  SELECT user.id, user.name, user.age::BIGINT AS age
  FROM users AS user
  LEFT JOIN ages AS age ON user.id = age.user_id
`;

async function verify(): Promise<void> {
  const rows = await db.execute(query);
  type Actual = (typeof rows)[number];
  type Expected = { id: number; name: string; age: bigint | null };
  type ResultIsExact = Assert<Equal<Actual, Expected>>;
  const checked: ResultIsExact = true;
  void checked;
}

void verify;
