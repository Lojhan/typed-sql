import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import { connectionString } from "./connection.mjs";

const name = process.env.TYPED_SQL_FIRST_USE_DATABASE;
connectionString(name); // Validate our generated identifier before SQL interpolation.
const admin = await createSqlServerOdbcDatabase({ connectionString: connectionString("master") });
try {
  assert.equal(admin.serverEvidence.version, process.env.TYPED_SQL_SQLSERVER_BUILD);
  if (process.argv[2] === "create") {
    await admin.queryable.all(`CREATE DATABASE [${name}]`);
    const database = await createSqlServerOdbcDatabase({ connectionString: connectionString() });
    try {
      // The public factory establishes canonical SET options, including ARITHABORT
      // required by the exact tutorial fixture's filtered index.
      await database.queryable.all(
        await readFile(new URL("../first-use-commerce-schema.sql", import.meta.url), "utf8"),
      );
      const tables = await database.queryable.all("SELECT name FROM sys.tables ORDER BY name");
      assert.deepEqual(
        tables.map((row) => row.name),
        ["audit_events", "memberships", "order_items", "orders", "products", "teams", "users"],
      );
    } finally {
      await database.close();
    }
  } else {
    assert.equal(process.argv[2], "drop");
    await admin.queryable.all(
      `IF DB_ID(N'${name}') IS NOT NULL BEGIN ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]; END`,
    );
  }
} finally {
  await admin.close();
}
console.log(`First-use ${process.argv[2]} completed for owned disposable database`);
