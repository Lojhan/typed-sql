import assert from "node:assert/strict";
export function connectionString(database = process.env.TYPED_SQL_FIRST_USE_DATABASE) {
  const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
  assert.ok(password && !/[;{}]/u.test(password));
  assert.match(database ?? "", /^(?:master|typed_sql_first_use_[a-f0-9]{20})$/u);
  return `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=${database};UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
}
