import assert from "node:assert/strict";
import * as sdk from "@duckdb/node-api";

assert.equal(sdk.version(), process.env.TYPED_SQL_DUCKDB_EXPECTED_ENGINE);
const instance = await sdk.DuckDBInstance.create("persistent.duckdb"),
  connection = await instance.connect();
let closing;
const close = () =>
  (closing ??= (async () => {
    try {
      const result = await connection.run("ROLLBACK");
      result.closeSync();
    } finally {
      connection.closeSync();
      instance.closeSync();
      if (process.connected) process.disconnect();
    }
  })());
process.on("message", (message) => {
  if (message === "close") void close();
});
process.on("SIGTERM", () => void close());
const version = await connection.run("SELECT version()");
try {
  assert.equal((await version.getRows())[0][0], sdk.version());
} finally {
  version.closeSync();
}
const begin = await connection.run("BEGIN TRANSACTION");
begin.closeSync();
const write = await connection.run("UPDATE records SET amount=amount WHERE id=4");
write.closeSync();
process.send({ ready: true, engine: sdk.version() });
