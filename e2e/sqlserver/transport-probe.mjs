import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import sql from "msnodesqlv8";

const require = createRequire(import.meta.url);
const driverVersion = require("msnodesqlv8/package.json").version;
const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
if (!password || /[;{}]/u.test(password))
  throw new Error("Provide a disposable SQL Server password without DSN delimiters");
const major = Number(process.env.TYPED_SQL_SQLSERVER_MAJOR);
if (![14, 15, 16, 17].includes(major)) throw new Error("An explicit qualified SQL Server engine major is required");
const artifact = resolve(
  process.env.TYPED_SQL_SQLSERVER_ARTIFACT ?? `../../artifacts/sqlserver/transport-${major}.json`,
);
const dsn = `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=master;UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
// TrustServerCertificate is confined to this disposable loopback CI server, never an adapter default.
const evidence = {
  formatVersion: 1,
  driver: { name: "msnodesqlv8", version: driverVersion },
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  image: process.env.TYPED_SQL_SQLSERVER_IMAGE,
  cases: [],
};
let connection;
function safeError(error) {
  return String(error).replaceAll(password, "[redacted]");
}
function exactTimestamp(value) {
  assert.ok(value instanceof Date && Number.isFinite(value.getTime()), "Expected a valid native Date");
  assert.ok(Object.hasOwn(value, "nanosecondsDelta"), "Exact temporal precision requires native augmentation");
  const nanos = Math.round(value.nanosecondsDelta * 1e9);
  assert.ok(Number.isSafeInteger(nanos) && nanos >= 0 && nanos < 1000000 && nanos % 100 === 0);
  return value
    .toISOString()
    .replace(/\.(\d{3})Z$/u, (_, millis) => `.${millis}${String(nanos / 100).padStart(4, "0")}Z`);
}
function representation(value) {
  if (value instanceof Date)
    return { iso: value.toISOString(), nanosecondsDelta: value.nanosecondsDelta, exact: exactTimestamp(value) };
  if (typeof value === "bigint") return { bigint: String(value) };
  if (value instanceof Uint8Array) return { bytes: Array.from(value) };
  return value;
}
async function run(name, operation) {
  const started = Date.now();
  try {
    const result = await operation();
    evidence.cases.push({ name, status: "pass", durationMs: Date.now() - started, result });
  } catch (error) {
    evidence.cases.push({ name, status: "fail", error: safeError(error) });
    throw error;
  }
}
async function query(text, parameters = []) {
  const result = await connection.promises.query(
    { query_str: text, query_timeout: 15, numeric_string: true },
    parameters,
  );
  assert.equal(result.errors.length, 0);
  return result;
}
async function one(text, parameters = []) {
  const result = await query(text, parameters);
  assert.equal(result.results.length, 1);
  assert.equal(result.first.length, 1);
  return result.first[0];
}
try {
  assert.equal(process.arch, "x64", "SQL Server qualification requires native x86-64; emulation is not evidence");
  assert.equal(driverVersion, "6.2.2");
  const deadline = Date.now() + 180000;
  while (!connection && Date.now() < deadline) {
    try {
      connection = await sql.promises.open({ conn_str: dsn, conn_timeout: 3 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  assert.ok(connection, "Disposable SQL Server did not become available");
  connection.setUseUTC(true);
  connection.setUseNumericString(true);
  connection.setMaxPreparedColumnSize(1024 * 1024);
  evidence.server = await one(
    "SELECT CONVERT(varchar(128),SERVERPROPERTY('ProductVersion')) AS version, CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS major, CONVERT(varchar(128),SERVERPROPERTY('Edition')) AS edition, CONVERT(varchar(128),SERVERPROPERTY('ProductUpdateLevel')) AS updateLevel",
  );
  assert.equal(Number(evidence.server.major), major);
  if (process.env.TYPED_SQL_SQLSERVER_BUILD)
    assert.equal(evidence.server.version, process.env.TYPED_SQL_SQLSERVER_BUILD);
  const settings = await query("DBCC USEROPTIONS");
  evidence.settings = settings.first;
  // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query owns this formatting placeholder.
  evidence.odbc = execFileSync("dpkg-query", ["-W", "-f=${Version}", "msodbcsql18"], { encoding: "utf8" }).trim();
  assert.equal(evidence.odbc, process.env.TYPED_SQL_ODBC_VERSION);
  evidence.unixOdbc = execFileSync("odbcinst", ["-j"], { encoding: "utf8" }).split("\n")[0];
  for (const level of [140, 150, 160, 170].filter((level) => level <= major * 10)) {
    const name = `typed_sql_qualification_${level}`;
    await query(`CREATE DATABASE [${name}] COLLATE SQL_Latin1_General_CP1_CI_AS`);
    await query(`ALTER DATABASE [${name}] SET COMPATIBILITY_LEVEL = ${level}`);
    await query(`USE [${name}]`);
    const compat = await one("SELECT compatibility_level AS level FROM sys.databases WHERE name = DB_NAME()");
    assert.equal(Number(compat.level), level);
    await query(
      "SET ANSI_WARNINGS ON; SET ARITHABORT ON; SET QUOTED_IDENTIFIER ON; SET NUMERIC_ROUNDABORT OFF; SET NOCOUNT ON",
    );
    await run(`compat-${level}.numeric-output`, async () => {
      const result = await one(
        "SELECT CAST('99999999999999999999999999999999999999' AS decimal(38,0)) AS wide, CAST('0.99999999999999999999999999999999999999' AS decimal(38,38)) AS fraction, CAST('-1234567890123456789012345678.1234567890' AS decimal(38,10)) AS negative, CAST('922337203685477.5807' AS money) AS moneyMax, CAST('-922337203685477.5808' AS money) AS moneyMin, CAST('214748.3647' AS smallmoney) AS smallMax, CAST('-214748.3648' AS smallmoney) AS smallMin, CAST(9223372036854775807 AS bigint) AS bigintMax, CAST(-9223372036854775808 AS bigint) AS bigintMin, CAST(0 AS decimal(10,4)) AS zero, CAST(NULL AS decimal(38,10)) AS empty",
      );
      assert.deepEqual(result, {
        wide: "99999999999999999999999999999999999999",
        fraction: "0.99999999999999999999999999999999999999",
        negative: "-1234567890123456789012345678.1234567890",
        moneyMax: "922337203685477.5807",
        moneyMin: "-922337203685477.5808",
        smallMax: "214748.3647",
        smallMin: "-214748.3648",
        bigintMax: "9223372036854775807",
        bigintMin: "-9223372036854775808",
        zero: "0.0000",
        empty: null,
      });
      return result;
    });
    await run(`compat-${level}.exact-bound-text`, async () => {
      const input = "1234567890123456789012345678.1234567890";
      const result = await one(
        "SELECT CONVERT(decimal(38,10),?) AS first, CONVERT(decimal(38,10),?) AS repeated, CONVERT(decimal(38,10),?) AS empty",
        [sql.NVarChar(input), sql.NVarChar(input), sql.NVarChar(null)],
      );
      assert.deepEqual(result, { first: input, repeated: input, empty: null });
      return result;
    });
    await run(`compat-${level}.prepared-numeric`, async () => {
      const prepared = await new Promise((resolve, reject) =>
        connection.prepare(
          {
            query_str: "SELECT CONVERT(decimal(38,10),?) AS exact, CONVERT(decimal(38,10),?) AS empty",
            numeric_string: true,
          },
          (error, value) => (error ? reject(error) : resolve(value)),
        ),
      );
      try {
        const input = "-1234567890123456789012345678.1234567890";
        for (const value of [input, "0.0000000000", "0.1000000000"]) {
          const result = await prepared.promises.query([sql.NVarChar(value), sql.NVarChar(null)]);
          assert.deepEqual(result.first, [{ exact: value, empty: null }]);
        }
        return { executions: 3, metadata: prepared.getMeta() };
      } finally {
        await prepared.promises.free();
      }
    });
    await run(`compat-${level}.temporal-100ns`, async () => {
      const dates = [
        "0001-01-01T00:00:00.0000001",
        "0099-12-31T23:59:59.9999999",
        "0100-01-01T00:00:00.1234567",
        "1969-12-31T23:59:59.9999999",
        "2000-02-29T12:34:56.1234567",
        "9999-12-31T23:59:59.9999999",
      ];
      const result = [];
      for (const input of dates) {
        const row = await one("SELECT CONVERT(datetime2(7),?,126) AS value", [sql.NVarChar(input)]);
        assert.equal(exactTimestamp(row.value), `${input}Z`);
        result.push(representation(row.value));
      }
      for (const [input, expected] of [
        ["2026-11-05T12:34:56.1234567+05:45", "2026-11-05T06:49:56.1234567Z"],
        ["2026-11-05T12:34:56.1234567-03:30", "2026-11-05T16:04:56.1234567Z"],
      ]) {
        const row = await one("SELECT CONVERT(datetimeoffset(7),?,127) AS value", [sql.NVarChar(input)]);
        assert.equal(exactTimestamp(row.value), expected);
        result.push(representation(row.value));
      }
      return result;
    });
    await run(`compat-${level}.dml-output-and-rollback`, async () => {
      await query(
        "CREATE TABLE transport_values(id int NOT NULL PRIMARY KEY, amount decimal(38,10), moment datetime2(7), label nvarchar(max), bytes varbinary(max))",
      );
      const amount = "1234567890123456789012345678.1234567890";
      const moment = "2026-11-05T12:34:56.1234567";
      const label = "Ada'; DROP TABLE transport_values; -- 😀";
      const inserted = await one(
        "INSERT INTO transport_values OUTPUT inserted.amount,inserted.moment,inserted.label,inserted.bytes VALUES(1,CONVERT(decimal(38,10),?),CONVERT(datetime2(7),?,126),?,?)",
        [sql.NVarChar(amount), sql.NVarChar(moment), sql.NVarChar(label), sql.VarBinary(Buffer.from([0, 255]))],
      );
      assert.equal(inserted.amount, amount);
      assert.equal(exactTimestamp(inserted.moment), `${moment}Z`);
      assert.equal(inserted.label, label);
      assert.deepEqual(Array.from(inserted.bytes), [0, 255]);
      await query("BEGIN TRANSACTION");
      await query("UPDATE transport_values SET amount=CONVERT(decimal(38,10),?) WHERE id=1", [
        sql.NVarChar("0.1000000000"),
      ]);
      await query("ROLLBACK");
      assert.equal((await one("SELECT amount FROM transport_values WHERE id=1")).amount, amount);
      const text = "😀".repeat(5000);
      const unicode = await one("SELECT CONVERT(nvarchar(max),?) AS value", [sql.NVarChar(text)]);
      assert.equal(unicode.value, text);
      return {
        amount: inserted.amount,
        moment: representation(inserted.moment),
        unicodeLength: text.length,
        bytes: Array.from(inserted.bytes),
        rollback: true,
      };
    });
    await run(`compat-${level}.prepared-long-unicode`, async () => {
      const prepared = await new Promise((resolve, reject) =>
        connection.prepare(
          { query_str: "SELECT CONVERT(nvarchar(max),?) AS value", numeric_string: true },
          (error, value) => (error ? reject(error) : resolve(value)),
        ),
      );
      try {
        for (const input of ["short", "😀".repeat(5000), "", "longer after empty"]) {
          const result = await prepared.promises.query([sql.NVarChar(input)]);
          assert.equal(result.first[0].value, input);
        }
        const nul = "left\0right";
        const result = await one("SELECT CONVERT(nvarchar(max),?) AS value", [sql.NVarChar(nul)]);
        return { executions: 4, maxUtf16Length: 10000, embeddedNullPreserved: result.value === nul };
      } finally {
        await prepared.promises.free();
      }
    });
    await run(`compat-${level}.prepared-max-results`, async () => {
      connection.setMaxPreparedColumnSize(64);
      let prepared;
      try {
        prepared = await new Promise((resolve, reject) =>
          connection.prepare(
            {
              query_str:
                "SELECT REPLICATE(CONVERT(nvarchar(max),N'é😀'),5000) AS textValue, CONVERT(varbinary(max),REPLICATE(CONVERT(varchar(max),'abcdef'),5000)) AS binaryValue",
              numeric_string: true,
              max_prepared_column_size: 64,
            },
            (error, value) => (error ? reject(error) : resolve(value)),
          ),
        );
        const result = await prepared.promises.query([]);
        const row = result.first[0];
        const textExact = row.textValue === "é😀".repeat(5000);
        const binaryExact = Buffer.from(row.binaryValue).equals(Buffer.from("abcdef".repeat(5000)));
        return {
          outcome: "success",
          textExact,
          binaryExact,
          textLength: row.textValue.length,
          binaryLength: row.binaryValue.length,
          warnings: result.info,
          metadata: prepared.getMeta(),
          silentTruncation: (!textExact || !binaryExact) && result.info.length === 0,
        };
      } catch (error) {
        return { outcome: "detected-error", error: safeError(error) };
      } finally {
        await prepared?.promises.free();
        connection.setMaxPreparedColumnSize(1024 * 1024);
        assert.equal(Number((await one("SELECT 1 AS recovered")).recovered), 1);
      }
    });
    await run(`compat-${level}.collation-inputs`, async () => {
      const legacy = await one(
        "SELECT CONVERT(varchar(8),? COLLATE Latin1_General_100_CI_AS) AS value, DATALENGTH(CONVERT(varchar(8),? COLLATE Latin1_General_100_CI_AS)) AS bytes",
        [sql.NVarChar("é€"), sql.NVarChar("é€")],
      );
      assert.equal(legacy.value, "é€");
      assert.equal(Number(legacy.bytes), 2);
      const unrepresentable = await one("SELECT CONVERT(varchar(8),? COLLATE Latin1_General_100_CI_AS) AS value", [
        sql.NVarChar("漢"),
      ]);
      assert.notEqual(unrepresentable.value, "漢", "Preflight must reject a codepage substitution");
      const result = { cp1252: legacy.value, unrepresentableSubstitutionObserved: true };
      if (major >= 15) {
        const input = "😀😀";
        const utf8 = await one(
          "SELECT CONVERT(varchar(8),? COLLATE Latin1_General_100_CI_AS_SC_UTF8) AS value, DATALENGTH(CONVERT(varchar(8),? COLLATE Latin1_General_100_CI_AS_SC_UTF8)) AS bytes",
          [sql.NVarChar(input), sql.NVarChar(input)],
        );
        assert.equal(utf8.value, input);
        assert.equal(Number(utf8.bytes), 8);
        await query("CREATE TABLE unicode_values(value varchar(8) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NOT NULL)");
        await query(
          "INSERT INTO unicode_values VALUES(CONVERT(varchar(8),? COLLATE Latin1_General_100_CI_AS_SC_UTF8))",
          [sql.NVarChar(input)],
        );
        assert.equal((await one("SELECT value FROM unicode_values")).value, input);
        const truncated = await one("SELECT CONVERT(varchar(8),? COLLATE Latin1_General_100_CI_AS_SC_UTF8) AS value", [
          sql.NVarChar("😀😀é"),
        ]);
        assert.notEqual(truncated.value, "😀😀é", "Preflight must reject an oversized UTF8 encoding");
        result.utf8 = utf8.value;
        result.utf8Bytes = Number(utf8.bytes);
        result.truncationObserved = true;
        result.differentDatabaseAndColumnCodepages = true;
      }
      return result;
    });
    await run(`compat-${level}.conversion-semantics`, async () => {
      const result = await query(
        "SELECT DISTINCT CONVERT(decimal(38,10),?) AS value FROM (VALUES(1),(2)) AS t(id) ORDER BY value",
        [sql.NVarChar("2.1000000000")],
      );
      assert.deepEqual(result.first, [{ value: "2.1000000000" }]);
      const row = await one("SELECT ISNULL(CONVERT(decimal(38,10),?),CONVERT(decimal(38,10),?)) AS value", [
        sql.NVarChar(null),
        sql.NVarChar("0.1000000000"),
      ]);
      assert.equal(row.value, "0.1000000000");
      return { distinct: result.first, isnull: row.value };
    });
    await query("USE [master]");
    await query(`DROP DATABASE [${name}]`);
  }
  evidence.summary = { pass: evidence.cases.length, fail: 0 };
  console.log(`SQL Server ${major}: ${evidence.cases.length} native transport probes passed`);
} catch (error) {
  evidence.failure = safeError(error);
  evidence.summary = {
    pass: evidence.cases.filter((item) => item.status === "pass").length,
    fail: evidence.cases.filter((item) => item.status === "fail").length || 1,
  };
  throw new Error(safeError(error));
} finally {
  try {
    await connection?.promises.close();
  } catch (error) {
    evidence.cleanupFailure = safeError(error);
    process.exitCode = 1;
  } finally {
    await mkdir(resolve(artifact, ".."), { recursive: true });
    await writeFile(artifact, JSON.stringify(evidence, null, 2));
  }
}
