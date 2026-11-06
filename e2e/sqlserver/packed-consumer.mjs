import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileSqlFile } from "@typed-sql/compiler";
import { SqlServerSchemaProvider, sqlserver } from "@typed-sql/sqlserver";
import { connectSqlServerOdbc, createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";

const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
assert.ok(password && !/[;{}]/u.test(password));
const connectionString = `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=typed_sql_adapter_140;UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
assert.ok(import.meta.resolve("@typed-sql/sqlserver/odbc").includes("/node_modules/"));
const database = await createSqlServerOdbcDatabase({ connectionString });
try {
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
  await database.close();
}
const connection = await connectSqlServerOdbc({ connectionString });
try {
  const started = Date.now();
  await assert.rejects(
    connection.execute("WAITFOR DELAY '00:00:10'; SELECT 1 AS value", [], { deadline: Date.now() + 100 }),
  );
  assert.ok(Date.now() - started < 4000);
} finally {
  await connection.close();
}
console.log(
  "Isolated tarballs: exact values, prepared statements, streaming, native cancellation and worker cleanup passed",
);
