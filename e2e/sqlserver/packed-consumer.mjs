import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileSqlFile } from "@typed-sql/compiler";
import { SqlServerSchemaProvider, sqlserver } from "@typed-sql/sqlserver";
import { connectSqlServerOdbc, createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";

const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
assert.ok(password && !/[;{}]/u.test(password));
const name = `typed_sql_packed_${randomBytes(10).toString("hex")}`;
assert.match(name, /^typed_sql_packed_[a-f\d]{20}$/u);
const dsn = (database) =>
  `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=${database};UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
const connectionString = dsn(name);
assert.ok(import.meta.resolve("@typed-sql/sqlserver/odbc").includes("/node_modules/"));
const admin = await createSqlServerOdbcDatabase({ connectionString: dsn("master") });
let created = false;
let cleanupFailure;
async function closeOwned(resource, label) {
  try {
    await resource.close();
  } catch (error) {
    cleanupFailure ??= error;
    console.error(`${label} close failed: ${String(error).replaceAll(password, "[redacted]")}`);
  }
}
try {
  assert.equal(admin.serverEvidence.version, process.env.TYPED_SQL_SQLSERVER_BUILD);
  await admin.queryable.all(`CREATE DATABASE [${name}] COLLATE SQL_Latin1_General_CP1_CI_AS`);
  created = true;
  // Preserve the original packed fixture's lower compatibility target on every engine.
  await admin.queryable.all(`ALTER DATABASE [${name}] SET COMPATIBILITY_LEVEL=140`);
  const database = await createSqlServerOdbcDatabase({ connectionString });
  try {
    assert.equal(database.serverEvidence.settings.compatibilityLevel, 140);
    assert.equal(database.serverEvidence.version, process.env.TYPED_SQL_SQLSERVER_BUILD);
    await database.queryable.all(
      "CREATE TABLE dbo.packed_values(id bigint NOT NULL PRIMARY KEY,label nvarchar(max) NOT NULL,amount decimal(38,10) NOT NULL,bytes varbinary(max) NOT NULL)",
    );
    const schema = await new SqlServerSchemaProvider({
      client: database.queryable,
      includeSchemas: ["dbo"],
    }).introspect();
    let sequence = 0;
    const compile = async (source) => {
      const compiled = compileSqlFile({ source, schema, dialect: sqlserver() });
      assert.deepEqual(compiled.diagnostics, []);
      const path = resolve(`${sequence++}.mjs`);
      await writeFile(path, compiled.runtime);
      await writeFile(path.replace(/\.mjs$/u, ".d.mts"), compiled.text);
      return (await import(pathToFileURL(path).href)).default;
    };
    const insert = await compile(
      "INSERT INTO dbo.packed_values(id,label,amount,bytes) OUTPUT inserted.id,inserted.label,inserted.amount,inserted.bytes VALUES(:id,:label,:amount,:bytes)",
    );
    const select = await compile("SELECT id,label,amount,bytes FROM dbo.packed_values WHERE id=:id OR id=:id");
    await writeFile(
      "type-proof.ts",
      `import select from './1.mjs';
import {createSqlServerOdbcDatabase} from '@typed-sql/sqlserver/odbc';
import koffi from 'koffi';
export const injectedSdk=()=>createSqlServerOdbcDatabase({connectionString:'application-owned',driverImporter:async()=>koffi});
select({id:1n});
// @ts-expect-error SQL BIGINT bindings require bigint
select({id:'wrong'});
`,
    );
    const expected = {
      id: 9223372036854775807n,
      label: "😀漢字é\0".repeat(10000),
      amount: "1234567890123456789012345678.1234567890",
      bytes: new Uint8Array(),
    };
    assert.deepEqual(await database.one(insert(expected)), expected);
    const prepared = database.prepare("packed-values", select);
    assert.deepEqual(await database.one(prepared({ id: expected.id })), expected);
    await database.unprepare("packed-values");
    const iterator = database.stream(select({ id: expected.id }), { batchSize: 1 })[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, expected);
    await iterator.return();
    assert.deepEqual(await database.one(select({ id: expected.id })), expected);
  } finally {
    await closeOwned(database, "Packed database");
  }
  const connection = await connectSqlServerOdbc({ connectionString });
  try {
    const started = Date.now();
    await assert.rejects(
      connection.execute("WAITFOR DELAY '00:00:10'; SELECT 1 AS value", [], { deadline: Date.now() + 100 }),
    );
    assert.ok(Date.now() - started < 4000);
  } finally {
    await closeOwned(connection, "Packed cancellation connection");
  }
} finally {
  if (created) {
    try {
      await admin.queryable.all(
        `ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]`,
      );
      const dropped = await admin.queryable.all(`SELECT DB_ID(N'${name}') AS owned_database_id`);
      assert.equal(dropped.length, 1);
      assert.equal(dropped[0].owned_database_id, null, "Admin catalog independently confirms packed fixture cleanup");
    } catch (error) {
      cleanupFailure = error;
      console.error(`Packed database cleanup failed: ${String(error).replaceAll(password, "[redacted]")}`);
    }
  }
  await closeOwned(admin, "Packed admin");
}
// A primary test error propagates through the finally block; cleanup cannot mask it.
if (cleanupFailure) throw cleanupFailure;
console.log(
  "Isolated tarballs: exact values, prepared statements, streaming, native cancellation, worker and owned database cleanup passed",
);
