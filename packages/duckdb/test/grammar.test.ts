import { describe, it, strict } from "poku";
import { duckDBServerEvidence, duckdb } from "../src/index.js";
import type { DuckDBSchemaSnapshot } from "../src/snapshot.js";
import { fixtureEvidence } from "./helpers/evidence.js";

const snapshot: DuckDBSchemaSnapshot = {
  formatVersion: 1,
  dialect: "duckdb",
  dialectVersion: "1.0.0",
  server: fixtureEvidence("v2.0.0", { currentCatalog: "db", currentSchema: "main" }),
  tables: {
    '"db"."main"."users"': {
      name: "users",
      schema: "main",
      columns: {
        id: { name: "id", databaseType: "BIGINT", tsType: "bigint", nullable: false },
        email: { name: "email", databaseType: "VARCHAR", tsType: "string", nullable: false },
        team_id: { name: "team_id", databaseType: "INTEGER", tsType: "number", nullable: true },
      },
    },
  },
};
await describe("DuckDB owned grammar analysis", async () => {
  await it("infers rows, ordered parameters, native nested values and source diagnostics", () => {
    const result = duckdb().analyze("SELECT u.id,u.email FROM users u WHERE u.id=$1", snapshot);
    strict.deepEqual(result.diagnostics, []);
    strict.deepEqual(
      result.columns.map((x) => [x.name, x.tsType, x.nullable]),
      [
        ["id", "bigint", false],
        ["email", "string", false],
      ],
    );
    strict.equal(result.parameters[0]?.tsType, "bigint");
    const nested = duckdb().analyze(
      "SELECT {'id':id,'email':email} AS document, list(id) AS ids FROM users GROUP BY id,email",
      snapshot,
    );
    strict.deepEqual(nested.diagnostics, []);
    strict.match(nested.columns[0]!.tsType, /readonly "id": bigint/u);
    strict.match(nested.columns[1]!.tsType, /readonly \(bigint \| null\)\[\]/u);
    const invalid = duckdb().analyze("SELECT missing FROM users", snapshot);
    strict.equal(invalid.diagnostics[0]?.code, "TSQ101");
    strict.ok(invalid.diagnostics[0]!.range.start > 0);
  });
  await it("supports CTEs, windows QUALIFY, DML returning and rejects unsupported suffixes", () => {
    for (const query of [
      "WITH u AS (SELECT id,email FROM users) SELECT id FROM u WHERE id=$1",
      "SELECT id,row_number() OVER(PARTITION BY team_id ORDER BY id) AS rank FROM users QUALIFY rank=1",
      "INSERT INTO users(id,email,team_id) VALUES ($1,$2,$3) RETURNING id,email",
      "UPDATE users SET email=$1 WHERE id=$2 RETURNING id",
      "DELETE FROM users WHERE id=$1 RETURNING id",
    ]) {
      const result = duckdb().analyze(query, snapshot);
      strict.deepEqual(result.diagnostics, [], query);
    }
    for (const query of [
      "SELECT id FROM users; DELETE FROM users",
      "SELECT id FROM users GARBAGE SUFFIX",
      "PIVOT users ON email USING count(*)",
      "SELECT mystery(id) FROM users",
    ]) {
      strict.ok(
        duckdb()
          .analyze(query, snapshot)
          .diagnostics.some((x) => x.severity === "error"),
        query,
      );
    }
  });
});
await it("fails closed on unqualified engine evidence and retains branded parameter contracts", () => {
  const future = { ...snapshot, server: duckDBServerEvidence("2.1.0") };
  strict.equal(duckdb().analyze("SELECT id FROM users", future).diagnostics[0]?.code, "TSQ402");
  const branded: DuckDBSchemaSnapshot = {
    ...snapshot,
    tables: {
      users: {
        name: "users",
        schema: "main",
        columns: {
          id: {
            name: "id",
            databaseType: "BIGINT",
            nullable: false,
            tsType: 'import("@typed-sql/core").Brand<bigint, "UserId">',
          },
        },
      },
    },
  };
  const result = duckdb().analyze("SELECT id FROM users WHERE id=$1", branded);
  strict.deepEqual(result.diagnostics, []);
  strict.equal(result.columns[0]?.tsType, result.parameters[0]?.tsType);
  strict.equal(result.columns[0]?.range.start, 7);
});

await it("rejects semantic settings that change proven typing rules", () => {
  const incompatible = { ...snapshot, server: duckDBServerEvidence("2.0.0", [], { integer_division: "true" }) };
  strict.equal(duckdb().analyze("SELECT 4/2 AS value", incompatible).diagnostics[0]?.code, "TSQ402");
});
await it("retains DISTINCT/aggregate/window dependencies and FROM-first projections", () => {
  for (const query of [
    "SELECT row_number() OVER(PARTITION BY missing ORDER BY id) AS rank FROM users",
    "SELECT list(id ORDER BY missing) AS ids FROM users",
    "SELECT DISTINCT ON(missing) id FROM users",
    "SELECT row_number() OVER missing AS rank FROM users",
    "SELECT row_number() AS rank FROM users",
    "SELECT coalesce() AS value",
    "SELECT struct_pack(1) AS value",
    "SELECT array_value() AS value",
  ])
    strict.ok(duckdb().analyze(query, snapshot).diagnostics.length, query);
  for (const query of [
    "FROM users SELECT DISTINCT id",
    "SELECT id AS value FROM users WHERE value>1",
    "SELECT id,row_number() OVER w AS rank FROM users WINDOW w AS(PARTITION BY team_id ORDER BY id) QUALIFY rank=1",
    "SELECT list(id ORDER BY email) AS ids FROM users",
  ])
    strict.deepEqual(duckdb().analyze(query, snapshot).diagnostics, [], query);
});
await it("binds lambda variables, nested closures and versioned arrow syntax", () => {
  for (const query of [
    "SELECT list_transform([1,2],lambda x:x+1) AS values",
    "SELECT [x*2 FOR x IN [1,2,3] IF x>1] AS values",
    "SELECT list_transform([1],lambda x:x+team_id) AS values FROM users",
    "SELECT MAP {'a':1,'b':2} AS value",
  ])
    strict.deepEqual(duckdb().analyze(query, snapshot).diagnostics, [], query);
  for (const query of [
    "SELECT list_transform([1],lambda x:missing) AS value",
    "SELECT list_transform([1],lambda x,y,z:x) AS value",
    "SELECT list_filter([1],lambda x:MAP {'a':1}) AS value",
    "SELECT list_transform([1],x -> x+1) AS value",
    "SELECT MAP {'a':1}+1 AS value",
  ])
    strict.ok(duckdb().analyze(query, snapshot).diagnostics.length, query);
  const legacy = { ...snapshot, server: fixtureEvidence("1.5.6") };
  strict.deepEqual(duckdb().analyze("SELECT list_transform([1],x -> x+1) AS value", legacy).diagnostics, []);
  const collision = duckdb().analyze("SELECT id::VARCHAR AS id FROM users WHERE id=$1", snapshot);
  strict.deepEqual(collision.diagnostics, []);
  strict.equal(collision.parameters[0]?.tsType, "bigint");
});
await it("recognizes canonical named binds in expressions without consuming native colons", () => {
  const source = "SELECT {'id':id,'param': :input} AS document FROM users WHERE id=:id OR id=:id /* :comment */";
  const parameters = duckdb().parameterOccurrences!(source, snapshot);
  strict.deepEqual(
    parameters.map((parameter) => parameter.name),
    ["input", "id", "id"],
  );
  strict.deepEqual(
    parameters.map((parameter) => source.slice(parameter.range.start, parameter.range.end)),
    [":input", ":id", ":id"],
  );
  strict.deepEqual(duckdb().analyze("SELECT id FROM users WHERE id=:id", snapshot).diagnostics, []);
  strict.deepEqual(
    duckdb().parameterOccurrences!("SELECT MAP {'key': :value}, [1,2][:finish], $$:string$$", snapshot).map(
      (parameter) => parameter.name,
    ),
    ["value"],
  );
});
await it("requires recorded critical settings rather than invented snapshot defaults", () => {
  for (const version of ["1.5.6", "2.0.0"]) {
    const complete = fixtureEvidence(version);
    for (const name of [
      "Calendar",
      "integer_division",
      "preserve_identifier_case",
      ...(version === "1.5.6" ? ["old_implicit_casting"] : []),
    ]) {
      const settings = { ...complete.settings };
      delete settings[name];
      const target = { ...snapshot, server: duckDBServerEvidence(version, [], settings) };
      strict.equal(duckdb().analyze("SELECT 1 AS value", target).diagnostics[0]?.code, "TSQ402", `${version}:${name}`);
    }
  }
  const parameters = duckdb().parameterOccurrences!("SELECT ((:id))::BIGINT", snapshot);
  strict.equal(parameters[0]?.name, "id");
  strict.equal(parameters[0]?.range.start, 9);
  strict.equal(parameters[0]?.range.end, 12);
});
