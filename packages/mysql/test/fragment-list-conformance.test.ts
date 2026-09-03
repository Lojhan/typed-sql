import { assertFragmentListConformance } from "@typed-sql/conformance";
import { describe, it, strict } from "poku";
import { type MySqlSchemaSnapshot, mysql, sql } from "../src/index.js";
import { mysqlRenderer } from "../src/runtime.js";

const snapshot = {
  formatVersion: 1,
  dialect: "mysql",
  dialectVersion: "1.0.0",
  tables: {
    users: {
      name: "users",
      columns: {
        id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
        email: { name: "email", databaseType: "text", tsType: "string", nullable: false },
      },
    },
  },
} as const satisfies MySqlSchemaSnapshot;

const rows = [
  { id: 1n, email: "one@example.test" },
  { id: 2n, email: "two@example.test" },
  { id: 3n, email: "three@example.test" },
  { id: 4n, email: "four@example.test" },
  { id: 5n, email: "five@example.test" },
] as const;
const query = (cardinality: 1 | 2 | 5) =>
  sql`INSERT INTO users (id, email) VALUES ${rows
    .slice(0, cardinality)
    .map((row) => sql.fragment`(${row.id}, ${row.email})`)}`;
const text = (cardinality: number) =>
  `INSERT INTO users (id, email) VALUES ${Array.from({ length: cardinality }, () => "(?, ?)").join(", ")}`;

await describe("MySQL fragment-list conformance", async () => {
  await it("satisfies shared artifacts, DML, diagnostics, and rendering", () => {
    const compilerSource = [
      'import { sql } from "@typed-sql/mysql";',
      "declare const rows: readonly { readonly id: bigint; readonly email: string }[];",
      "sql`INSERT INTO users (id, email) VALUES ${rows.map((row) => sql.fragment`(${row.id}, ${row.email})`)}`;",
    ].join("\n");
    const report = assertFragmentListConformance({
      name: "mysql.fragment-list.insert",
      dialect: mysql(),
      renderer: mysqlRenderer,
      snapshot,
      compilerSource,
      expectedRepresentativeSql: text(2),
      expectedRowType: "never",
      expectedResultKind: "command",
      expectedElementParameters: [
        { index: 1, tsType: "bigint", nullable: false, databaseType: "bigint" },
        { index: 2, tsType: "string", nullable: false, databaseType: "text" },
      ],
      renderCases: ([1, 2, 5] as const).map((cardinality) => ({
        name: `${cardinality}-rows`,
        cardinality,
        query: query(cardinality),
        expectedText: text(cardinality),
        expectedValues: rows.slice(0, cardinality).flatMap(({ id, email }) => [id, email]),
      })),
      diagnostics: [
        {
          name: "row-arity",
          source: compilerSource.replace("(${row.id}, ${row.email})", "(${row.id})"),
          diagnosticCode: "TSQ214",
        },
      ],
    });
    strict.strictEqual(report.grammar, "mysql");
    strict.deepStrictEqual(report.renderCardinalities, [1, 2, 5]);
  });
});
