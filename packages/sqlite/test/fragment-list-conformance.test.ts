import { assertFragmentListConformance } from "@typed-sql/conformance";
import { describe, it, strict } from "poku";
import { fragmentListCases, fragmentRows as rows } from "../../../test/helpers/fragment-list.js";
import { type SqliteSchemaSnapshot, sql, sqlite } from "../src/index.js";
import { sqliteRenderer } from "../src/runtime.js";

const snapshot = {
  formatVersion: 1,
  dialect: "sqlite",
  dialectVersion: "1.0.0",
  version: "3.53.0",
  server: {
    product: "sqlite",
    version: "3.53.0",
    versionKey: "3.53.0",
    features: [],
    settings: {},
  },
  tables: {
    users: {
      schema: "main",
      name: "users",
      kind: "table",
      strict: true,
      withoutRowid: false,
      indexes: [],
      foreignKeys: [],
      columns: {
        id: { name: "id", databaseType: "INTEGER", tsType: "bigint", nullable: false },
        email: { name: "email", databaseType: "TEXT", tsType: "string", nullable: false },
      },
    },
  },
} as const satisfies SqliteSchemaSnapshot;

const query = (cardinality: 1 | 2 | 5) =>
  sql`INSERT INTO users (id, email) VALUES ${rows
    .slice(0, cardinality)
    .map((row) => sql.fragment`(${row.id}, ${row.email})`)}`;
const text = (cardinality: number) =>
  `INSERT INTO users (id, email) VALUES ${Array.from({ length: cardinality }, () => "(?, ?)").join(", ")}`;

await describe("SQLite fragment-list conformance", async () => {
  await it("satisfies shared artifacts, DML, diagnostics, and rendering", () => {
    const compilerSource = [
      'import { sql } from "@typed-sql/sqlite";',
      "declare const rows: readonly { readonly id: bigint; readonly email: string }[];",
      "sql`INSERT INTO users (id, email) VALUES ${rows.map((row) => sql.fragment`(${row.id}, ${row.email})`)}`;",
    ].join("\n");
    const report = assertFragmentListConformance({
      name: "sqlite.fragment-list.insert",
      dialect: sqlite(),
      renderer: sqliteRenderer,
      snapshot,
      compilerSource,
      expectedRepresentativeSql: text(2),
      expectedRowType: "never",
      expectedResultKind: "command",
      expectedElementParameters: [
        { index: 1, tsType: "bigint", nullable: false, databaseType: "INTEGER" },
        { index: 2, tsType: "string", nullable: false, databaseType: "TEXT" },
      ],
      renderCases: fragmentListCases(query, text),
      diagnostics: [
        {
          name: "row-arity",
          source: compilerSource.replace("(${row.id}, ${row.email})", "(${row.id})"),
          diagnosticCode: "TSQ214",
        },
      ],
    });
    strict.strictEqual(report.grammar, "sqlite");
    strict.deepStrictEqual(report.renderCardinalities, [1, 2, 5]);
  });
});
