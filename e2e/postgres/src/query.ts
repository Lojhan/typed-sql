import { createPgDatabase } from "@typed-sql/postgres/pg";
import { sql, typePolicy } from "../generated/db/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

const query = sql`
  SELECT user_account.id,
         user_account.email,
         user_account.status,
         project.budget::NUMERIC AS budget
  FROM users AS user_account
  LEFT JOIN projects AS project ON user_account.id = project.owner_id
  ORDER BY user_account.id
`;

async function verifyGeneratedTypes(): Promise<void> {
  const database = await createPgDatabase({
    connectionString: "postgresql://unused-at-typecheck",
    typePolicy,
  });
  const rows = await database.execute(query);

  type Actual = (typeof rows)[number];
  type Expected = {
    id: bigint;
    email: string;
    status: "active" | "suspended";
    budget: string | null;
  };
  type ResultIsExact = Assert<Equal<Actual, Expected>>;
  const checked: ResultIsExact = true;
  void checked;
  await database.close();
}

void verifyGeneratedTypes;
