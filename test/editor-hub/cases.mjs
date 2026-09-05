// Grammar syntax and type-policy expectations live here, never in host adapters.
const column = (name, databaseType, tsType, nullable = false) => ({ name, databaseType, tsType, nullable });
const sqlCase = (id, version, types) => ({
  id,
  packageName: `@typed-sql/${id}`,
  packageDirectory: `packages/${id}`,
  factory: id,
  schema: {
    formatVersion: 1,
    dialect: id,
    dialectVersion: "1.0.0",
    version,
    tables: {
      users: {
        name: "users",
        ...(id === "sqlite"
          ? { schema: "main", kind: "table", strict: true, withoutRowid: false, indexes: [], foreignKeys: [] }
          : {}),
        columns: {
          id: column("id", types.id, id === "sqlite" ? "bigint" : "number"),
          name: column("name", types.text, "string"),
          age: column("age", types.age, "number", true),
        },
      },
    },
  },
  initial: { query: "SELECT id, name FROM users", member: "name", type: "string", completions: ["id", "name"] },
  changed: { query: "SELECT id, age AS name FROM users", member: "name", type: "number | null" },
  wrongType: "number",
  invalidQuery: "SELECT not_a_column FROM users",
  diagnosticPattern: "not_a_column",
  schemaRefresh: { table: "users", column: "name", type: "string | null" },
});

export const grammarCases = [
  sqlCase("postgres", "16", { id: "integer", text: "text", age: "real" }),
  sqlCase("mysql", "8.4.0", { id: "int", text: "varchar", age: "double" }),
  sqlCase("sqlite", "3.51.0", { id: "INTEGER", text: "TEXT", age: "REAL" }),
  {
    id: "synthetic",
    packageName: "@typed-sql/example-synthetic-grammar",
    packageDirectory: "examples/synthetic-grammar",
    factory: "synthetic",
    schema: {
      formatVersion: 1,
      dialect: "synthetic",
      dialectVersion: "1.0.0",
      version: "1.0.0",
      tables: {
        widgets: {
          name: "widgets",
          columns: {
            value: column("value", "scalar", "number"),
            label: column("label", "text", "string", true),
          },
        },
      },
    },
    initial: { query: "SELECT value FROM widgets", member: "value", type: "number", completions: ["value"] },
    changed: { query: "SELECT label FROM widgets", member: "label", type: "string | null" },
    wrongType: "string",
    invalidQuery: "UNSUPPORTED",
    diagnosticPattern: "does not support",
  },
];

export const interfaces = [
  "row-hover",
  "row-completion",
  "typescript-diagnostic",
  "source-definition",
  "ordinary-hover",
  "unsaved-query-refresh",
  "sql-diagnostic",
  "schema-file-refresh",
];

export function sourceFor(spec, variant = spec.initial) {
  return [
    `import { sql } from ${JSON.stringify(spec.packageName)};`,
    'import { db } from "./database.js";',
    `const query = sql\`${variant.query}\`; const ordinary = { count: 1 }; void ordinary.count;`,
    "async function verify() {",
    "  const rows = await db.execute(query);",
    "  const row = rows[0]!;",
    `  const correct: ${spec.initial.type} = row.${variant.member};`,
    `  const wrong: ${spec.wrongType} = row.${variant.member};`,
    `  return row.${variant.member};`,
    "}",
    "void verify;",
    "",
  ].join("\n");
}
