import { it, strict } from "poku";
import { duckdb } from "../src/analysis.js";
import { createNodeDuckDBDatabase } from "../src/node-api.js";
import { DuckDBSchemaProvider } from "../src/provider.js";

const sdk =
  process.env.TYPED_SQL_DUCKDB_SDK === "15" ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const version = process.env.TYPED_SQL_DUCKDB_SDK === "15" ? "1.5.6" : "2.0.0";
await it(`captures genuine DuckDB${version} constraints, indexes, generated fields and namespace filters`, async () => {
  strict.equal(sdk.version(), `v${version}`);
  const database = await createNodeDuckDBDatabase({ sdkImporter: async () => sdk });
  try {
    strict.deepEqual(await database.queryable.all("SELECT version() AS version"), [{ version: `v${version}` }]);
    for (const statement of [
      "CREATE SCHEMA secondary",
      "CREATE SEQUENCE generated_ids",
      "CREATE TABLE parent(id INTEGER PRIMARY KEY,label VARCHAR UNIQUE,CHECK(length(label)>0))",
      "CREATE TABLE child(id BIGINT DEFAULT nextval('generated_ids') PRIMARY KEY,parent_id INTEGER REFERENCES parent(id))",
      "CREATE INDEX child_parent ON child(parent_id)",
      "CREATE TABLE generated_columns(x INTEGER,y INTEGER GENERATED ALWAYS AS(x+1))",
      "CREATE TABLE secondary.other(value MAP(VARCHAR,STRUCT(n BIGINT)))",
      "CREATE VIEW child_view AS SELECT id,parent_id FROM child",
      "CREATE MACRO twice(value) AS value+value",
    ])
      await database.queryable.all(statement);
    const snapshot = await new DuckDBSchemaProvider({ client: database.queryable }).introspect();
    if (snapshot.formatVersion !== 2) throw new Error("Expected structural catalog snapshot");
    strict.ok(Object.values(snapshot.relations).some((relation) => relation.kind === "view"));
    const constraints = Object.values(snapshot.relations).flatMap((relation) => relation.constraints);
    for (const kind of ["primary-key", "unique", "check", "foreign-key"])
      strict.ok(
        constraints.some((constraint) => constraint.kind === kind),
        kind,
      );
    strict.ok(Object.values(snapshot.relations).some((relation) => relation.indexes.length));
    strict.ok(
      Object.values(snapshot.relations).some((relation) =>
        Object.values(relation.columns).some(
          (column) => column.generated === "virtual" && !column.insertable && !column.updatable,
        ),
      ),
    );
    strict.ok(snapshot.extension);
    for (const query of ["INSERT INTO generated_columns(y) VALUES(1)", "UPDATE generated_columns SET y=1"])
      strict.ok(duckdb().analyze(query, snapshot).diagnostics.length, query);
    strict.deepEqual(duckdb().analyze("INSERT INTO generated_columns VALUES(1) RETURNING y", snapshot).diagnostics, []);

    const filtered = await new DuckDBSchemaProvider({
      client: database.queryable,
      schemas: ["secondary"],
    }).introspect();
    strict.deepEqual(
      Object.values(filtered.tables).map((table) => table.name),
      ["other"],
    );
    const empty = await new DuckDBSchemaProvider({ client: database.queryable, catalogs: ["absent"] }).introspect();
    strict.deepEqual(Object.keys(empty.tables), []);
  } finally {
    await database.close();
  }
});
