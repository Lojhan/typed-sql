import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as sdk from "@duckdb/node-api";
import { compileSqlFile } from "@typed-sql/compiler";
import { DuckDBSchemaProvider, duckdb } from "@typed-sql/duckdb";
import { createNodeDuckDBDatabase } from "@typed-sql/duckdb/node-api";
import { sql } from "@typed-sql/duckdb/query";

assert.equal(sdk.version(), process.env.TYPED_SQL_DUCKDB_EXPECTED_ENGINE);
const path = resolve("persistent.duckdb");
let db = await createNodeDuckDBDatabase({ path });
const grammar = duckdb();
async function compile(name, source, snapshot) {
  const result = compileSqlFile({ dialect: grammar, schema: snapshot, source });
  assert.deepEqual(result.diagnostics, [], source);
  await writeFile(`${name}.mjs`, result.runtime);
  await writeFile(`${name}.d.mts`, result.text);
  await writeFile(`${name}.sql`, source);
  return (await import(pathToFileURL(resolve(`${name}.mjs`)).href)).default;
}
const row = {
  id: 9223372036854775807n,
  amount: "1234567890123456789012345678.1234567890",
  profile: {
    label: "😀漢字",
    ids: [1n, null, -2n],
    attrs: [
      [1, "one"],
      [2, null],
    ],
    choice: { tag: "n", value: null },
  },
  coordinates: [1, null, 3],
  bytes: Uint8Array.from([0, 255, 128]),
};
try {
  await db.queryable.all(
    "CREATE TABLE records(id BIGINT PRIMARY KEY,amount DECIMAL(38,10) NOT NULL,profile STRUCT(label VARCHAR,ids BIGINT[],attrs MAP(INTEGER,VARCHAR),choice UNION(n BIGINT,s VARCHAR)) NOT NULL,coordinates INTEGER[3] NOT NULL,bytes BLOB NOT NULL)",
  );
  const snapshot = await new DuckDBSchemaProvider({ client: db.queryable }).introspect();
  assert.equal(snapshot.server.version, sdk.version());
  await writeFile("schema.json", JSON.stringify(snapshot, null, 2));
  const insert = await compile(
    "insert",
    "INSERT INTO records (id,amount,profile,coordinates,bytes) VALUES (:id,:amount,:profile,:coordinates,:bytes) RETURNING id,amount,profile,coordinates,bytes",
    snapshot,
  );
  const find = await compile(
    "find",
    "SELECT id,amount,profile,coordinates,bytes FROM records WHERE id=$id OR id=$id",
    snapshot,
  );
  const positional = await compile("positional", "SELECT id FROM records WHERE id=$1", snapshot);
  const all = await compile("all", "SELECT id FROM records ORDER BY id", snapshot);
  assert.deepEqual(await db.one(insert(row)), row);
  assert.deepEqual(await db.one(find({ id: row.id })), row);
  assert.deepEqual(await db.one(positional(row.id)), { id: row.id });
  const prepared = db.prepare("find", find);
  assert.deepEqual(await db.one(prepared({ id: row.id })), row);
  await db.unprepare("find");
  await assert.rejects(db.batch([insert({ ...row, id: 2n }), insert({ ...row, id: 2n })]));
  assert.equal(await db.maybeOne(find({ id: 2n })), undefined);
  await assert.rejects(
    db.transaction(async (scope) => {
      await scope.one(insert({ ...row, id: 3n }));
      throw new Error("intentional rollback");
    }),
    /intentional rollback/u,
  );
  assert.equal(await db.maybeOne(find({ id: 3n })), undefined);
  await db.one(insert({ ...row, id: 4n }));
  for await (const value of db.stream(all())) {
    assert.equal(value.id, 4n);
    break;
  }
  assert.deepEqual(await db.all(all()), [{ id: 4n }, { id: row.id }]);
  let calls = 0;
  const validator = {
    "~standard": {
      version: 1,
      vendor: "packed-consumer",
      validate(value) {
        calls++;
        return { value };
      },
    },
  };
  assert.deepEqual(await db.one(sql.validateResult(find({ id: row.id }), validator)), row);
  assert.equal(calls, 1);
  await assert.rejects(async () => db.one(insert({ ...row, id: 5n, coordinates: [1, 2] })));
  assert.equal(await db.maybeOne(find({ id: 5n })), undefined);
  await writeFile(
    "type-proof.ts",
    `import insert from './insert.mjs';
import find from './find.mjs';
import positional from './positional.mjs';
import {createNodeDuckDBDatabase} from '@typed-sql/duckdb/node-api';
import * as sdk from '@duckdb/node-api';
const acceptsInstalledSdk = () => createNodeDuckDBDatabase({sdkImporter: async () => sdk});
void acceptsInstalledSdk;
find({id: 1n}); positional(1n);
// @ts-expect-error bigint input is required
find({id: 'wrong'});
// @ts-expect-error positional bigint input is required
positional(1);
const row = {id: 1n, amount: '1.0000000000', profile: {label: 'x', ids: [1n], attrs: [[1,'one']] as const, choice: {tag:'n',value:null} as const}, coordinates:[1,2,3] as const,bytes:new Uint8Array()};
insert(row);
// @ts-expect-error native fixed arrays retain their length
insert({...row,coordinates:[1,2]});
`,
  );
  await db.close();
  db = await createNodeDuckDBDatabase({ path });
  assert.deepEqual(await db.one(find({ id: row.id })), row);
  console.log(
    JSON.stringify({
      engine: sdk.version(),
      cases: [
        "public provider",
        "SQL modules",
        "named and positional inputs",
        "nested MAP/UNION/STRUCT/ARRAY",
        "exact decimal/bigint",
        "prepared",
        "atomic batch",
        "transaction rollback",
        "early stream close",
        "validator",
        "invalid input before mutation",
        "persistent reopen",
      ],
    }),
  );
} finally {
  await db.close();
}
