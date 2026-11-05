import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { compileSqlFile } from "@typed-sql/compiler";
import { SqlServerSchemaProvider, sqlserver } from "@typed-sql/sqlserver";
import { createSqlServerMsnodesqlv8Database } from "@typed-sql/sqlserver/msnodesqlv8";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import { sql } from "@typed-sql/sqlserver/query";
import { createSqlServerLiveVerifier, createSqlServerPlanInspector } from "@typed-sql/sqlserver/runtime";
import native from "msnodesqlv8";
import { DDL, MATURITY_CASES } from "../../packages/sqlserver/test/helpers/maturity-corpus.ts";

const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
assert.ok(password && !/[;{}]/u.test(password), "Disposable password without DSN delimiters required");
const major = Number(process.env.TYPED_SQL_SQLSERVER_MAJOR);
assert.ok([14, 15, 16, 17].includes(major));
assert.equal(process.arch, "x64", "Native SQL Server evidence requires x86-64");
const dsn = (database) =>
  `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=${database};UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
const evidence = { formatVersion: 1, major, cases: [] };
const qualificationFailures = [];
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
async function check(name, operation, { continueOnFailure = false } = {}) {
  const started = Date.now();
  try {
    await operation();
    evidence.cases.push({ name, status: "pass", durationMs: Date.now() - started });
  } catch (error) {
    evidence.cases.push({ name, status: "fail", error: String(error).replaceAll(password, "[redacted]") });
    if (continueOnFailure) qualificationFailures.push(name);
    else throw error;
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
        for (const statement of DDL) await db.queryable.all(statement);
        await db.queryable.all(
          "INSERT INTO dbo.widgets(id,code,quantity,tiny,amount,adjustment,document,active) VALUES (1,N'sample',-7,1,-1.23,0.001,N'{}',0)",
        );
      });
      const schema = await new SqlServerSchemaProvider({ client: db.queryable, includeSchemas: ["dbo"] }).introspect();
      await writeFile(resolve(generated, `schema-${level}.json`), JSON.stringify(schema, null, 2));
      await check(`${level}: native verification and SHOWPLAN services`, async () => {
        const pool = {
          async acquire() {
            const connection = await createSqlServerOdbcDatabase({
              connectionString: dsn(`typed_sql_adapter_${level}`),
            });
            return {
              all: (text, values) => connection.queryable.all(text, values),
              release: () => connection.close(),
              discard: () => connection.close(),
            };
          },
        };
        const verifier = createSqlServerLiveVerifier({ pool });
        const inspector = createSqlServerPlanInspector({ pool });
        try {
          const request = {
            fingerprint: `sha256:${"a".repeat(64)}`,
            operation: "read",
            sql: "SELECT amount FROM dbo.widgets WHERE id=@__typed_sql_1",
          };
          const described = await verifier.verify(request);
          assert.equal(described.columns[0].databaseType, "decimal(12,2)");
          assert.equal(described.parameters[0].databaseType, "bigint");
          assert.equal(
            verifier.compareDatabaseTypes("decimal(12,4)", described.columns[0].databaseType, "column"),
            "different",
          );
          const environment = await inspector.environment();
          assert.match(environment.statisticsFingerprint, /^sha256:[a-f\d]{64}$/u);
          const plan = await inspector.capture({ ...request, parameterCount: 1 });
          assert.ok(plan.nodes.length > 0);
          evidence.cases.push({ name: `${level}: native services evidence`, status: "evidence", described, plan });
        } finally {
          await verifier.close();
          await inspector.close();
        }
      });
      await check(`${level}: exact default VARCHAR MAX and guarded compatibility adapter`, async () => {
        for (const input of ["", "x\0", "é\0".repeat(20000), "\0".repeat(40000)]) {
          const [actual] = await db.queryable.all("SELECT CONVERT(varchar(max),?) AS value", [input]);
          assert.equal(actual.value, input);
        }
        if (major >= 15) {
          const input = "😀漢字é\0".repeat(10000);
          const [actual] = await db.queryable.all(
            "SELECT CONVERT(varchar(max),? COLLATE Latin1_General_100_CI_AS_SC_UTF8) AS value",
            [input],
          );
          assert.equal(actual.value, input);
        }
        const compatibility = await createSqlServerMsnodesqlv8Database({
          connectionString: dsn(`typed_sql_adapter_${level}`),
        });
        try {
          const unsupported = await compile(schema, "SELECT CAST('x' AS varchar(max)) AS value");
          await assert.rejects(compatibility.one(unsupported()), /VARCHAR|varchar|unsupported|exact|fidelity/iu);
        } finally {
          await compatibility.close();
        }
      });
      const insert = await compile(
        schema,
        "INSERT INTO dbo.adapter_values (id,amount,label,active,bytes,happened) OUTPUT inserted.id,inserted.amount,inserted.label,inserted.active,inserted.bytes,inserted.happened VALUES (:id,:amount,:label,:active,:bytes,:happened)",
      );
      const find = await compile(
        schema,
        "SELECT id,amount,label,active,bytes,happened FROM dbo.adapter_values WHERE id=:id OR id=:id",
      );
      const all = await compile(schema, "SELECT id FROM dbo.adapter_values ORDER BY id");
      const qualifyCorpus = async () => {
        const cases = [];
        const normalize = (type) =>
          String(type)
            .toLowerCase()
            .replace(/\s+collate\s+.+$/u, "")
            .replace(/\s+/gu, "")
            .replace(/^float\(53\)$/u, "float");
        for (const test of MATURITY_CASES) {
          const analysis = grammar.analyze(test.sql, schema);
          const diagnostics = analysis.diagnostics.filter((item) => item.severity === "error");
          let metadata, failure;
          try {
            metadata = await db.queryable.all(
              "SELECT name,system_type_name,is_nullable,error_number,error_message FROM sys.dm_exec_describe_first_result_set(?,NULL,0) WHERE is_hidden=0 OR error_number IS NOT NULL ORDER BY column_ordinal",
              [test.sql],
            );
            const error = metadata.find((row) => row.error_number !== null && row.error_number !== undefined);
            if (error) failure = String(error.error_message);
          } catch (error) {
            failure = String(error).replaceAll(password, "[redacted]");
          }
          const expected = analysis.columns.map((column) => ({
            name: column.name,
            type: normalize(column.databaseType),
          }));
          const actual = metadata?.map((column) => ({ name: column.name, type: normalize(column.system_type_name) }));
          const exact = failure
            ? diagnostics.length > 0
            : diagnostics.length === 0 && JSON.stringify(expected) === JSON.stringify(actual);
          cases.push({ id: test.id, exact, expected, actual, diagnostics, ...(failure ? { failure } : {}), metadata });
        }
        evidence.cases.push({ name: `${level}: independent vendor corpus`, status: "evidence", cases });
        assert.deepEqual(
          cases.filter((item) => !item.exact).map(({ metadata: _metadata, ...item }) => item),
          [],
          "Native describe and static inference disagree",
        );
      };
      await check(`${level}: independent native prepared zero termination`, async () => {
        const connection = await native.promises.open({ conn_str: dsn(`typed_sql_adapter_${level}`) });
        const cases = [];
        try {
          for (const type of ["nvarchar(40)", "nvarchar(max)", "varbinary(max)"]) {
            const binary = type.startsWith("varbinary");
            const statement = await new Promise((resolve, reject) =>
              connection.prepare(
                { query_str: `SELECT CONVERT(${type},?) AS value`, numeric_string: true },
                (error, value) => (error ? reject(error) : resolve(value)),
              ),
            );
            try {
              for (const input of [
                "",
                "x\0",
                "x\0\0",
                "\0",
                "x\0y",
                ...(type === "nvarchar(max)"
                  ? ["😀漢字é\0".repeat(2000), "😀漢字é\0".repeat(10000), "\0".repeat(40000)]
                  : []),
              ]) {
                const value = binary ? Buffer.from(input) : input;
                const binding = binary ? native.VarBinary(value) : native.NVarChar(value);
                const raw = await connection.promises.query(
                  { query_str: `SELECT CONVERT(${type},?) AS value`, numeric_string: true },
                  [binding],
                );
                const rawValue = raw.first[0].value;
                const result = (await statement.promises.query([binding])).first[0].value;
                cases.push({
                  type,
                  inputLength: value.length,
                  rawLength: rawValue?.length ?? null,
                  rawExact: binary ? rawValue instanceof Uint8Array && value.equals(rawValue) : rawValue === value,
                  outputLength: result?.length ?? null,
                  preparedExact: binary ? result instanceof Uint8Array && value.equals(result) : result === value,
                  inputTail: binary ? Array.from(value.subarray(-8)) : input.slice(-8),
                  outputTail: result === null ? null : binary ? Array.from(result.subarray(-8)) : result.slice(-8),
                });
              }
            } finally {
              await statement.promises.free();
            }
          }
        } finally {
          await connection.promises.close();
        }
        evidence.cases.push({
          name: `${level}: raw native prepared string/binary fidelity`,
          status: "evidence",
          cases,
        });
      });
      await check(`${level}: independent native numeric promotion evidence`, async () => {
        const promotions = [];
        for (const fn of ["ABS", "CEILING", "FLOOR", "POWER", "SIGN", "DEGREES", "RADIANS"]) {
          for (const type of ["decimal(12,2)", "int", "smallint", "money", "bit", "real"]) {
            const expression = `${fn}(CAST(1 AS ${type})${fn === "POWER" ? ",2" : ""})`;
            try {
              const [metadata] = await db.queryable.all(
                `SELECT CONVERT(nvarchar(128),SQL_VARIANT_PROPERTY(${expression},'BaseType')) AS type,CONVERT(int,SQL_VARIANT_PROPERTY(${expression},'Precision')) AS precision,CONVERT(int,SQL_VARIANT_PROPERTY(${expression},'Scale')) AS scale`,
              );
              promotions.push({ fn, input: type, ...metadata });
            } catch (error) {
              promotions.push({ fn, input: type, rejected: String(error).replaceAll(password, "[redacted]") });
            }
          }
          const expression = `${fn}(amount${fn === "POWER" ? ",2" : ""})`;
          const [metadata] = await db.queryable.all(
            `SELECT CONVERT(nvarchar(128),SQL_VARIANT_PROPERTY(${expression},'BaseType')) AS type,CONVERT(int,SQL_VARIANT_PROPERTY(${expression},'Precision')) AS precision,CONVERT(int,SQL_VARIANT_PROPERTY(${expression},'Scale')) AS scale FROM dbo.widgets`,
          );
          promotions.push({ fn, input: "nonconstant table decimal(12,2)", ...metadata });
        }
        evidence.cases.push({ name: `${level}: numeric metadata`, status: "evidence", promotions });
      });
      // Keep qualifying the runtime after a metadata disagreement, then fail the
      // overall gate. A failing oracle must never hide later transport evidence.
      await check(`${level}: vendor corpus native result metadata`, qualifyCorpus, { continueOnFailure: true });
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
      await check(`${level}: empty binary and large NUL text stay exact`, async () => {
        const value = { ...row, id: 6n, label: "\0".repeat(40000), bytes: new Uint8Array() };
        assert.deepEqual(await db.one(insert(value)), value);
        const prepared = db.prepare(`nul-${level}`, find);
        assert.deepEqual(await db.one(prepared({ id: 6n })), value);
        await db.unprepare(`nul-${level}`);
        await db.queryable.all("DELETE FROM dbo.adapter_values WHERE id=6");
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
      await check(
        `${level}: isolated VARCHAR conversion fidelity`,
        async () => {
          for (const encoding of major >= 15 ? ["legacy", "utf8"] : ["legacy"]) {
            let failure;
            try {
              await promisify(execFile)(
                process.execPath,
                [fileURLToPath(new URL("varchar-fidelity.mjs", import.meta.url)), String(level), encoding],
                { timeout: 45000, maxBuffer: 65536 },
              );
            } catch (error) {
              failure = {
                message: String(error).replaceAll(password, "[redacted]"),
                signal: error.signal,
                code: error.code,
              };
            }
            const path = resolve(`../../artifacts/sqlserver/varchar-${major}-${level}-${encoding}.json`);
            const report = JSON.parse(await readFile(path, "utf8"));
            evidence.cases.push({
              name: `${level}: VARCHAR ${encoding}`,
              status: "evidence",
              ...report,
              ...(failure ? { failure } : {}),
            });
            // Negative control for the explicit compatibility SDK. Its known
            // corruption is why the public default uses counted direct ODBC.
            // The typed compatibility guard and exact default are asserted above.
            assert.ok(report.cases.length > 0, "Compatibility counterexample must leave evidence");
          }
        },
        { continueOnFailure: true },
      );
    } finally {
      await db.close();
    }
  }
  assert.deepEqual(qualificationFailures, [], "Native qualification has unresolved metadata disagreements");
} finally {
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2));
  await rm(generated, { recursive: true, force: true });
}
console.log(JSON.stringify({ major, passed: evidence.cases.length }));
