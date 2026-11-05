import { commerceFiles } from "./commerce-example.js";
import { featureExampleFiles } from "./feature-examples.js";
import { isPlaygroundDialect, type PlaygroundDialect } from "./schema-catalog.js";

export type WorkspaceFile = string;
export type WorkspaceFiles = Record<WorkspaceFile, string>;

export const WORKSPACE_LIMITS = { files: 40, fileLength: 40_000, totalLength: 200_000 } as const;

export function filePathError(path: string): string | undefined {
  if (!/^(?:[A-Za-z_][\w.-]*\/)*[A-Za-z_][\w.-]*\.(?:ts|sql)$/u.test(path))
    return "Use a relative .ts or .sql path, such as queries/account.sql.";
  if (path.split("/").some((part) => part === "node_modules" || part.startsWith("__")))
    return "This folder name is reserved by the playground.";
  return undefined;
}

export function validWorkspaceFiles(value: unknown): value is WorkspaceFiles {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= WORKSPACE_LIMITS.files &&
    entries.every(
      ([path, source]) =>
        filePathError(path) === undefined && typeof source === "string" && source.length <= WORKSPACE_LIMITS.fileLength,
    ) &&
    !entries.some(([path]) => entries.some(([other]) => other.startsWith(`${path}/`))) &&
    entries.reduce((sum, [, source]) => sum + (source as string).length, 0) <= WORKSPACE_LIMITS.totalLength
  );
}

export const LESSONS = [
  {
    id: "bindings",
    title: "SQL parameter bindings",
    description: "Named objects, repeated values, positional order, and imported query contracts.",
  },
  {
    id: "brands",
    title: "Branded application IDs",
    description: "Keep UserId and OrderId distinct through SQL files, templates, and results.",
  },
  {
    id: "commerce",
    title: "Commerce · full workspace",
    description: "Seven tables, CTEs, mapped inserts, JSON documents, and transactional workflows.",
  },
  {
    id: "workspace",
    title: "SQL + TypeScript files",
    description: "Import a SQL query and share schema and functions across files.",
  },
  {
    id: "basics",
    title: "Rows & parameters",
    description: "An ordinary SQL template. An exact row and parameter contract.",
  },
  { id: "joins", title: "Join nullability", description: "A LEFT JOIN can have no match. The result type tells you." },
  {
    id: "errors",
    title: "Catch a mistake",
    description: "A string cannot fill a bigint parameter. Inspect the underlined expression.",
  },
  {
    id: "unknown",
    title: "The safety boundary",
    description: "Dynamic SQL has an unknown row. No evidence means no guessed type.",
  },
] as const;

export type Lesson = (typeof LESSONS)[number]["id"];

export function lessonSupportsDialect(lesson: Lesson, dialect: PlaygroundDialect): boolean {
  return LESSONS.some(({ id }) => id === lesson) && isPlaygroundDialect(dialect);
}

export function lessonFiles(
  dialect: PlaygroundDialect,
  lesson: Lesson,
  schema: string,
): WorkspaceFiles & Record<"queries/account.ts" | "app.ts" | "schema/tables.sql", string> {
  if (lesson === "bindings" || lesson === "brands") return featureExampleFiles(dialect, lesson, schema);
  if (lesson === "commerce") {
    return commerceFiles(dialect);
  }
  const table = "users";
  const projection =
    lesson === "joins"
      ? "account.id, account.email, team.name AS team_name"
      : "account.id, account.email, account.status";
  const body =
    lesson === "unknown"
      ? 'sql.dynamic("SELECT * FROM users")'
      : `sql\`
  SELECT ${projection}
  FROM ${table} AS account${lesson === "joins" ? "\n  LEFT JOIN memberships AS membership ON membership.user_id = account.id\n  LEFT JOIN teams AS team ON team.id = membership.team_id" : ""}
  WHERE account.id = \${id}
\``;
  return {
    ...(lesson === "workspace"
      ? {
          "queries/account.sql": `-- name: accountById\nSELECT id, email, status\nFROM ${table}\nWHERE id = ${dialect === "postgres" || dialect === "duckdb" ? "$1" : "?"};\n`,
          "queries/summary.ts": `import { sql } from "@typed-sql/${dialect}";\n\nexport const accountSummary = sql\`SELECT id, ${dialect === "sqlite" || dialect === "sqlserver" || dialect === "duckdb" ? "lower(email)" : "display_email(email)"} AS label FROM ${table}\`;\n`,
          ...(["sqlite", "sqlserver", "duckdb"].includes(dialect)
            ? {}
            : {
                "schema/functions.sql":
                  dialect === "postgres"
                    ? "CREATE FUNCTION display_email(value text) RETURNS text\nLANGUAGE SQL IMMUTABLE AS $$ SELECT lower(value) $$;\n"
                    : "CREATE FUNCTION display_email(value TEXT) RETURNS TEXT\nDETERMINISTIC RETURN LOWER(value);\n",
              }),
        }
      : {}),
    "queries/account.ts":
      lesson === "workspace"
        ? `import { sql } from "@typed-sql/${dialect}";\n\nexport const accountById = (id: bigint) => ${body};\n`
        : `import { sql } from "@typed-sql/${dialect}";

// Hover sql, accountById, or the interpolated id.
export const accountById = (id: bigint) => ${body};
`,
    "app.ts":
      lesson === "workspace"
        ? `import accountFromSql from "./queries/account.sql";
import { accountById } from "./queries/account.ts";
import { accountSummary } from "./queries/summary.ts";
import type { QueryRow, QueryParameters, Database } from "@typed-sql/core";

const sqlQuery = accountFromSql(42n);
const templateQuery = accountById(42n);

type Account = QueryRow<typeof sqlQuery>;
type Parameters = QueryParameters<typeof sqlQuery>;

// Type-only adapter example. No database runs in the playground.
declare const database: Database;
const sqlRows = await database.all(sqlQuery);
const templateRows = await database.all(templateQuery);
const summaryRows = await database.all(accountSummary);
`
        : `import { accountById } from "./queries/account.ts";
import type { QueryRow, QueryParameters, Database } from "@typed-sql/core";

// Types follow your query across the import.
const query = accountById(${lesson === "errors" ? '"42"' : "42n"});
type Account = QueryRow<typeof query>;
type Parameters = QueryParameters<typeof query>;

// A type-only adapter example; no database runs in this playground.
declare const database: Database;
const rows = await database.all(query);
const account = rows[0];

`,
    "schema/tables.sql": schema,
  };
}
