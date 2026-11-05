import { describe, it, strict } from "poku";
import { duckDBServerEvidence, duckdb } from "../src/index.js";
import type { DuckDBSchemaSnapshot } from "../src/snapshot.js";

const snapshot: DuckDBSchemaSnapshot = {
  formatVersion: 1,
  dialect: "duckdb",
  dialectVersion: "1.0.0",
  server: duckDBServerEvidence("v2.0.0", [], { currentCatalog: "db", currentSchema: "main" }),
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
