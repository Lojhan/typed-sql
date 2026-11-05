import { COMMERCE_SCHEMAS } from "../../../../examples/shared/commerce-schema.js";
import type { PlaygroundDialect } from "./dialect-browser-runtime.js";

export const PLAYGROUND_DIALECTS = ["postgres", "mysql", "sqlite"] as const;
export function isPlaygroundDialect(value: unknown): value is PlaygroundDialect {
  return typeof value === "string" && PLAYGROUND_DIALECTS.includes(value as PlaygroundDialect);
}

export function isPlaygroundGrammarModule(value: string): boolean {
  return PLAYGROUND_DIALECTS.some((dialect) => value === `@typed-sql/${dialect}`);
}

export const PLAYGROUND_DIALECT_LABELS: Readonly<Record<PlaygroundDialect, string>> = Object.freeze({
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
});

export const DEFAULT_SCHEMAS: Readonly<Record<PlaygroundDialect, string>> = COMMERCE_SCHEMAS;

export const DEFAULT_SOURCES: Readonly<Record<PlaygroundDialect, string>> = Object.freeze({
  postgres: `import { sql } from "@typed-sql/postgres";

const accountId: bigint = 42n;

const accountById = sql\`
  SELECT account.id, account.email, account.status
  FROM users AS account
  WHERE account.id = \${accountId}
\`;`,
  mysql: `import { sql } from "@typed-sql/mysql";

const accountId: bigint = 42n;

const accountById = sql\`
  SELECT account.id, account.email, account.status
  FROM users AS account
  WHERE account.id = \${accountId}
\`;`,
  sqlite: `import { sql } from "@typed-sql/sqlite";

const accountId: bigint = 42n;

const accountById = sql\`
  SELECT account.id, account.email, account.status
  FROM users AS account
  WHERE account.id = \${accountId}
\`;`,
});

export type { PlaygroundDialect } from "./dialect-browser-runtime.js";
