import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import native from "msnodesqlv8";

const [levelText, encoding] = process.argv.slice(2);
const level = Number(levelText);
assert.ok([140, 150, 160, 170].includes(level));
assert.ok(["legacy", "utf8"].includes(encoding));
const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
assert.ok(password && !/[;{}]/u.test(password));
const major = Number(process.env.TYPED_SQL_SQLSERVER_MAJOR);
const output = resolve(`../../artifacts/sqlserver/varchar-${major}-${level}-${encoding}.json`);
const report = { major, level, encoding, cases: [] };
mkdirSync(dirname(output), { recursive: true });
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
const dsn = `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=typed_sql_adapter_${level};UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
const connection = await native.promises.open({ conn_str: dsn });
const digest = (value) => createHash("sha256").update(value, "utf16le").digest("hex");
try {
  const expression =
    encoding === "utf8"
      ? "CONVERT(varchar(max),? COLLATE Latin1_General_100_CI_AS_SC_UTF8)"
      : "CONVERT(varchar(max),?)";
  for (const input of [
    "",
    "x\0",
    "\0",
    "x\0y",
    "é\0".repeat(20000),
    "\0".repeat(40000),
    ...(encoding === "utf8" ? ["😀漢字é\0".repeat(10000)] : []),
  ]) {
    const record = { inputLength: input.length, inputHash: digest(input), state: "native-started" };
    report.cases.push(record);
    // Persist before entering native code: a crash still leaves its exact last case.
    save();
    const value = (await connection.promises.query(`SELECT ${expression} AS value`, [native.NVarChar(input)])).first[0]
      .value;
    Object.assign(record, {
      state: "completed",
      outputLength: value?.length ?? null,
      outputHash: typeof value === "string" ? digest(value) : null,
      exact: value === input,
    });
    save();
  }
} finally {
  await connection.promises.close();
  save();
}
console.log(JSON.stringify({ major, level, encoding, cases: report.cases.length }));
