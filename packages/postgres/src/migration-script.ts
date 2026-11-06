import { tokenize } from "./parser/tokenizer.js";
import type { SourceRange, Token } from "./parser/types.js";

export interface PostgresMigrationStatement {
  readonly text: string;
  readonly range: SourceRange;
}

export class PostgresMigrationScriptError extends Error {
  readonly code = "POSTGRES_MIGRATION_SCRIPT";
  readonly range: SourceRange;

  constructor(message: string, range: SourceRange) {
    super(message);
    this.name = "PostgresMigrationScriptError";
    this.range = range;
  }
}

function word(token: Token | undefined): string {
  return token?.kind === "keyword" || token?.kind === "identifier" ? token.value.toUpperCase() : "";
}

function validateStatement(tokens: readonly Token[]): void {
  const first = tokens[0];
  if (first === undefined) return;
  const command = word(first);
  const second = word(tokens[1]);
  if (
    ["BEGIN", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE", "DISCARD"].includes(command) ||
    (command === "RESET" && second === "ALL") ||
    (command === "START" && second === "TRANSACTION") ||
    (command === "PREPARE" && second === "TRANSACTION") ||
    (command === "SET" && ["TRANSACTION", "SESSION"].includes(second))
  ) {
    throw new PostgresMigrationScriptError(
      "Migration scripts cannot manage transaction boundaries or session transaction settings; use the migration transaction policy.",
      first.range,
    );
  }
  if (tokens.some((token) => ["PG_ADVISORY_UNLOCK", "PG_ADVISORY_UNLOCK_ALL"].includes(word(token)))) {
    throw new PostgresMigrationScriptError(
      "Migration scripts cannot release runner advisory locks; use a separate explicitly coordinated operation.",
      first.range,
    );
  }
  if (
    command === "COPY" &&
    tokens.some((token, index) => word(token) === "FROM" && word(tokens[index + 1]) === "STDIN")
  ) {
    throw new PostgresMigrationScriptError(
      "COPY FROM STDIN is a client protocol operation and is not supported in migration scripts; use server-readable data or a separate explicit data-loading task.",
      first.range,
    );
  }
  if (tokens.some((token, index) => word(token) === "BEGIN" && word(tokens[index + 1]) === "ATOMIC")) {
    throw new PostgresMigrationScriptError(
      "SQL-standard BEGIN ATOMIC routine bodies are not supported in migration scripts; use a dollar-quoted routine body.",
      first.range,
    );
  }
}

/** Split only scanner-recognized statement separators, preserving strings and dollar-quoted bodies. */
export function postgresMigrationStatements(source: string): readonly PostgresMigrationStatement[] {
  const tokens = tokenize(source);
  const statements: PostgresMigrationStatement[] = [];
  let current: Token[] = [];
  const finish = (end: number): void => {
    const first = current[0];
    if (first === undefined) return;
    validateStatement(current);
    statements.push({
      text: source.slice(first.range.start, end),
      range: { ...first.range, end },
    });
    current = [];
  };
  for (const token of tokens) {
    if (token.kind === "eof") finish(source.length);
    else if (token.kind === "punctuation" && token.text === ";") finish(token.range.end);
    else current.push(token);
  }
  return statements;
}

/** Deliberately small declarative subset: no data statements, computed expressions or CTAS. */
export function validatePostgresReconciliation(source: string): void {
  const fail = (): never => {
    throw new PostgresMigrationScriptError(
      "Schema-only reconciliation supports simple CREATE TABLE with built-in types and literal defaults, CREATE INDEX, or ALTER TABLE ADD COLUMN without a default. Data transformations, computed expressions and unsupported DDL require separate inspection/proof.",
      { start: 0, end: source.length, line: 1, column: 1 },
    );
  };
  for (const statement of postgresMigrationStatements(source)) {
    const tokens = tokenize(statement.text).filter((token) => token.kind !== "eof" && token.text !== ";");
    let cursor = 0;
    const peek = (): string => word(tokens[cursor]);
    const consume = (expected: string): boolean => {
      if (peek() !== expected && tokens[cursor]?.text !== expected) return false;
      cursor += 1;
      return true;
    };
    const require = (expected: string): void => {
      if (!consume(expected)) fail();
    };
    const identifier = (): void => {
      const token = tokens[cursor];
      if (token?.kind !== "identifier" && token?.kind !== "quoted-identifier" && token?.kind !== "keyword") fail();
      cursor += 1;
    };
    const qualified = (): void => {
      identifier();
      if (consume(".")) identifier();
    };
    const identifiers = (): void => {
      require("(");
      identifier();
      while (consume(",")) identifier();
      require(")");
    };
    const literal = (): void => {
      consume("-");
      const token = tokens[cursor];
      if (!token || !(["string", "number"].includes(token.kind) || ["TRUE", "FALSE", "NULL"].includes(word(token))))
        fail();
      cursor += 1;
    };
    const column = (allowDefault = true): void => {
      identifier();
      const type = peek();
      if (
        ![
          "BIGINT",
          "INT8",
          "INTEGER",
          "INT",
          "INT4",
          "SMALLINT",
          "INT2",
          "TEXT",
          "BOOLEAN",
          "BOOL",
          "NUMERIC",
          "DECIMAL",
          "REAL",
          "FLOAT4",
          "FLOAT8",
          "DOUBLE",
          "VARCHAR",
          "CHARACTER",
          "CHAR",
          "BYTEA",
          "DATE",
          "TIMESTAMP",
          "TIMESTAMPTZ",
          "TIME",
          "UUID",
          "JSON",
          "JSONB",
        ].includes(type)
      )
        fail();
      cursor += 1;
      if (type === "DOUBLE") require("PRECISION");
      if (type === "CHARACTER") consume("VARYING");
      if (consume("(")) {
        if (tokens[cursor]?.kind !== "number") fail();
        cursor += 1;
        if (consume(",")) {
          if (tokens[cursor]?.kind !== "number") fail();
          cursor += 1;
        }
        require(")");
      }
      if ((type === "TIMESTAMP" || type === "TIME") && (consume("WITH") || consume("WITHOUT"))) {
        require("TIME");
        require("ZONE");
      }
      while (true) {
        if (consume("NOT")) require("NULL");
        else if (consume("NULL")) {
          /* Explicit nullable column. */
        } else if (consume("DEFAULT")) {
          if (!allowDefault) fail();
          literal();
        } else if (consume("PRIMARY")) require("KEY");
        else if (consume("UNIQUE")) {
          /* Built-in scalar uniqueness. */
        } else break;
      }
    };
    if (consume("ALTER")) {
      require("TABLE");
      qualified();
      require("ADD");
      consume("COLUMN");
      column(false);
    } else if (consume("CREATE")) {
      if (consume("TABLE")) {
        qualified();
        require("(");
        while (true) {
          if (consume("PRIMARY")) {
            require("KEY");
            identifiers();
          } else if (consume("UNIQUE")) identifiers();
          else column();
          if (!consume(",")) break;
        }
        require(")");
      } else {
        consume("UNIQUE");
        require("INDEX");
        consume("CONCURRENTLY");
        qualified();
        require("ON");
        qualified();
        if (consume("USING")) require("BTREE");
        require("(");
        while (true) {
          identifier();
          consume("ASC") || consume("DESC");
          if (consume("NULLS") && !consume("FIRST") && !consume("LAST")) fail();
          if (!consume(",")) break;
        }
        require(")");
        if (consume("INCLUDE")) identifiers();
      }
    } else fail();
    if (cursor !== tokens.length) fail();
  }
}
