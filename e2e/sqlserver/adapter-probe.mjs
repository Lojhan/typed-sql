import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileSqlFile } from "@typed-sql/compiler";
import { SqlServerSchemaProvider, sqlserver } from "@typed-sql/sqlserver";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import { sql } from "@typed-sql/sqlserver/query";
import native from "msnodesqlv8";

const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
assert.ok(password && !/[;{}]/u.test(password), "Disposable password without DSN delimiters required");
const major = Number(process.env.TYPED_SQL_SQLSERVER_MAJOR);
assert.ok([14, 15, 16, 17].includes(major));
assert.equal(process.arch, "x64", "Native SQL Server evidence requires x86-64");
const dsn = (database) =>
  `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=${database};UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
const evidence = { formatVersion: 1, major, cases: [] };
const output = resolve(`../../artifacts/sqlserver/adapter-${major}.json`);
const generated = await mkdtemp(new URL(".adapter-generated-", import.meta.url));
const grammar = sqlserver();
let sequence = 0;
async function compile(schema, source) {
  const result = compileSqlFile({ dialect: grammar, schema, source });
  assert.deepEqual(result.diagnostics, [], `SQL compilation: ${source}`);
  const path = resolve(generated, `${sequence++}.mjs`);
  await writeFile(path, result.runtime);
  return (await import(pathToFileURL(path).href)).default;
}
async function check(name, operation) {
  const started = Date.now();
  try {
    await operation();
    evidence.cases.push({ name, status: "pass", durationMs: Date.now() - started });
  } catch (error) {
    evidence.cases.push({ name, status: "fail", error: String(error).replaceAll(password, "[redacted]") });
    throw error;
  }
}

try {
  // Every session is opened against its final database. Changing USE after capturing
  // evidence would invalidate the runtime's database/compatibility attestation.
  const admin = await native.promises.open({ conn_str: dsn("master"), conn_timeout: 10 });
  try {
    for (const level of [140, 150, 160, 170].filter((level) => level <= major * 10)) {
      const database = `typed_sql_adapter_${level}`;
      await admin.promises.query(`CREATE DATABASE [${database}] COLLATE SQL_Latin1_General_CP1_CI_AS`);
      await admin.promises.query(`ALTER DATABASE [${database}] SET COMPATIBILITY_LEVEL=${level}`);
    }
  } finally {
    await admin.promises.close();
  }
  for (const level of [140, 150, 160, 170].filter((level) => level <= major * 10)) {
    const db = await createSqlServerOdbcDatabase({ connectionString: dsn(`typed_sql_adapter_${level}`) });
    try {
      await check(`${level}: factory and provider`, async () => {
        assert.equal(db.serverEvidence.version, process.env.TYPED_SQL_SQLSERVER_BUILD);
        await db.queryable.all(
          "CREATE TABLE dbo.adapter_values (id bigint NOT NULL PRIMARY KEY, amount decimal(38,10) NOT NULL, label nvarchar(max) NOT NULL, active bit NOT NULL, bytes varbinary(max) NOT NULL, happened datetime2(7) NOT NULL)",
        );
      });
      const schema = await new SqlServerSchemaProvider({ client: db.queryable, includeSchemas: ["dbo"] }).introspect();
      await writeFile(resolve(generated, `schema-${level}.json`), JSON.stringify(schema, null, 2));
      const insert = await compile(
        schema,
        "INSERT INTO dbo.adapter_values (id,amount,label,active,bytes,happened) OUTPUT inserted.id,inserted.amount,inserted.label,inserted.active,inserted.bytes,inserted.happened VALUES (:id,:amount,:label,:active,:bytes,:happened)",
      );
      const find = await compile(
        schema,
        "SELECT id,amount,label,active,bytes,happened FROM dbo.adapter_values WHERE id=:id OR id=:id",
      );
      const all = await compile(schema, "SELECT id FROM dbo.adapter_values ORDER BY id");
      const row = {
        id: 9223372036854775807n,
        amount: "1234567890123456789012345678.1234567890",
        label: "😀漢字é\0".repeat(2000),
        active: false,
        bytes: Uint8Array.from([0, 255, 128, 1]),
        happened: "1969-12-31T23:59:59.9999999",
      };
      await check(`${level}: compiled named INSERT OUTPUT and repeated SELECT`, async () => {
        assert.deepEqual(await db.one(insert(row)), row);
        assert.deepEqual(await db.one(find({ id: row.id })), row);
      });
      await check(`${level}: native prepared statement`, async () => {
        const prepared = db.prepare(`find-${level}`, find);
        assert.deepEqual(await db.one(prepared({ id: row.id })), row);
        assert.deepEqual(await db.one(prepared({ id: row.id })), row);
        await db.unprepare(`find-${level}`);
      });
      await check(`${level}: atomic root batch and transaction rollback`, async () => {
        const value = { ...row, id: 2n, label: "rollback" };
        await assert.rejects(db.batch([insert(value), insert(value)]));
        assert.equal(await db.maybeOne(find({ id: 2n })), undefined);
        await assert.rejects(
          db.transaction(async (scope) => {
            await scope.one(insert({ ...row, id: 3n }));
            throw new Error("intentional rollback");
          }),
          /intentional rollback/u,
        );
        assert.equal(await db.maybeOne(find({ id: 3n })), undefined);
      });
      await check(`${level}: lazy stream early close and recovery`, async () => {
        await db.one(insert({ ...row, id: 4n, label: "stream" }));
        const stream = db.stream(all());
        for await (const value of stream) {
          assert.equal(value.id, 4n);
          break;
        }
        assert.deepEqual(await db.all(all()), [{ id: 4n }, { id: row.id }]);
      });
      await check(`${level}: attached result validator`, async () => {
        let calls = 0;
        const validator = {
          "~standard": {
            version: 1,
            vendor: "native-adapter-probe",
            validate(value) {
              calls++;
              return { value };
            },
          },
        };
        assert.deepEqual(await db.one(sql.validateResult(find({ id: row.id }), validator)), row);
        assert.equal(calls, 1);
      });
      await check(`${level}: independent native numeric promotion evidence`, async () => {
        const promotions = [];
        for (const fn of ["ABS", "CEILING", "FLOOR", "POWER", "SIGN", "DEGREES", "RADIANS"]) {
          for (const type of ["decimal(12,2)", "int", "smallint", "money", "bit", "real"]) {
            const expression = `${fn}(CAST(1 AS ${type})${fn === "POWER" ? ",2" : ""})`;
            try {
              const [metadata] = await db.queryable.all(
                `SELECT SQL_VARIANT_PROPERTY(${expression},'BaseType') AS type,SQL_VARIANT_PROPERTY(${expression},'Precision') AS precision,SQL_VARIANT_PROPERTY(${expression},'Scale') AS scale`,
              );
              promotions.push({ fn, input: type, ...metadata });
            } catch (error) {
              promotions.push({ fn, input: type, rejected: String(error).replaceAll(password, "[redacted]") });
            }
          }
        }
        evidence.cases.push({ name: `${level}: numeric metadata`, status: "evidence", promotions });
      });
    } finally {
      await db.close();
    }
  }
} finally {
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2));
  await rm(generated, { recursive: true, force: true });
}
console.log(JSON.stringify({ major, passed: evidence.cases.length }));
