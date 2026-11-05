import assert from "node:assert/strict";
import { getQueryValuePlan } from "@typed-sql/core";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import { connectionString } from "./connection.mjs";
import { accountById, conditional, find, repeated } from "./dist/output.mjs";
import config from "./typed-sql.config.mjs";

const database = await createSqlServerOdbcDatabase({ connectionString: () => connectionString() });
try {
  assert.equal(database.serverEvidence.version, process.env.TYPED_SQL_SQLSERVER_BUILD);
  for (const query of [
    accountById(1n),
    find({ orderId: 9001n }),
    repeated([9001n, 9002n]),
    conditional(true),
    conditional(false),
  ])
    assert.equal(getQueryValuePlan(query)?.dialect, "sqlserver");
  assert.deepEqual(await database.one(accountById(1n)), { id: 1n, email: "ada@example.com", status: "active" });
  assert.deepEqual(await database.one(find({ orderId: 9001n })), {
    id: 9001n,
    user_id: 1n,
    email: "ada@example.com",
    amount: "32.9800000000",
  });
  assert.deepEqual(await database.all(repeated([9001n, 9002n])), [{ id: 9001n }, { id: 9002n }]);
  assert.deepEqual(await database.one(conditional(false)), { id: 9001n });
  assert.deepEqual(await database.one(conditional(true)), { id: 9001n, amount: "32.9800000000" });
  // Only explicit native service calls acquire from the lazily registered pool.
  assert.equal((await config.verification.live.server()).version, process.env.TYPED_SQL_SQLSERVER_BUILD);
  await config.plans.live.environment();
  console.log(
    "Packed CLI generation, declarations, esbuild SQL assets, inline/mapped/conditional queries and lazy native services executed",
  );
} finally {
  await Promise.all([database.close(), config.verification.live.close(), config.plans.live.close()]);
}
