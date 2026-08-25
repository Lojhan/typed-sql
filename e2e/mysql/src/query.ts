import { sql, typePolicy } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const query = sql`
  SELECT user_account.id,
         user_account.email,
         user_account.status,
         project.budget
  FROM users AS user_account
  LEFT JOIN projects AS project ON user_account.id = project.owner_id
  ORDER BY user_account.id
`;

const cteQuery = sql`
  WITH project_totals AS (
    SELECT project.owner_id,
           COUNT(*) AS project_count,
           SUM(project.budget) AS total_budget
    FROM projects AS project
    GROUP BY project.owner_id
  )
  SELECT user_account.id,
         user_account.profile->>'$.plan' AS plan,
         project_totals.project_count,
         project_totals.total_budget
  FROM users AS user_account
  LEFT JOIN project_totals ON project_totals.owner_id = user_account.id
  WHERE EXISTS (
    SELECT 1 AS present FROM projects
    WHERE projects.owner_id = user_account.id
  )
`;

const commandQuery = sql`
  INSERT INTO users (email, status, profile)
  VALUES (${"new@example.com"}, ${"active"}, ${'{"plan":"new"}'})
`;

async function verifyGeneratedTypes(): Promise<void> {
  const database = await createMySql2Database({ connectionUri: "mysql://unused-at-typecheck", typePolicy });
  const rows = await database.execute(query);
  type Actual = (typeof rows)[number];
  type Expected = { id: bigint; email: string; status: "active" | "suspended"; budget: string | null };
  const checked: Assert<Equal<Actual, Expected>> = true;
  void checked;

  const cteRows = await database.execute(cteQuery);
  type CteActual = (typeof cteRows)[number];
  type CteExpected = { id: bigint; plan: string | null; project_count: bigint | null; total_budget: string | null };
  const cteChecked: Assert<Equal<CteActual, CteExpected>> = true;
  void cteChecked;

  const commandRows = await database.execute(commandQuery);
  type CommandActual = (typeof commandRows)[number];
  const commandChecked: Assert<Equal<CommandActual, never>> = true;
  void commandChecked;
  await database.close();
}

void verifyGeneratedTypes;
