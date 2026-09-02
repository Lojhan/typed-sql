import { SqlToolkitError, TokenCursor } from "@typed-sql/ast/toolkit";
import { SqlTokenizeError, type TokenizeOptions, tokenize } from "./tokenizer.js";
import {
  type BetweenExpression,
  type CaseBranch,
  type CommonTableExpression,
  type CompoundSelect,
  type DeleteStatement,
  type Expression,
  type Identifier,
  type InsertStatement,
  type JoinClause,
  type JoinKind,
  mergeRanges,
  type NamedTableReference,
  type NamedWindow,
  type OrderByItem,
  type SelectItem,
  type SelectLockingClause,
  type SelectStatement,
  type SourceRange,
  type Statement,
  type TableReference,
  type Token,
  type TypeName,
  type UpdateAssignment,
  type UpdateStatement,
  type ValuesClause,
  type WindowFrameBoundary,
  type WindowSpecification,
  type WithClause,
} from "./types.js";

export const DEFAULT_MAX_PARSE_DEPTH = 128;

export interface ParseOptions extends TokenizeOptions {
  readonly maxDepth?: number;
}

export class SqlParseError extends Error {
  readonly code: string;
  readonly range: SourceRange;

  constructor(message: string, range: SourceRange, code = "TSQ001") {
    super(message);
    this.name = "SqlParseError";
    this.code = code;
    this.range = range;
  }
}

const precedence = new Map<string, number>([
  ["OR", 1],
  ["XOR", 2],
  ["AND", 3],
  ["&&", 3],
  ["=", 4],
  ["!=", 4],
  ["<>", 4],
  ["<", 4],
  ["<=", 4],
  [">", 4],
  [">=", 4],
  ["<=>", 4],
  ["IS", 4],
  ["LIKE", 4],
  ["|", 5],
  ["&", 6],
  ["<<", 7],
  [">>", 7],
  ["||", 8],
  ["+", 9],
  ["-", 9],
  ["*", 10],
  ["/", 10],
  ["%", 10],
  ["^", 11],
  ["->", 12],
  ["->>", 12],
]);

const typeContinuationWords = new Set([
  "BIT",
  "CHARACTER",
  "DOUBLE",
  "INTERVAL",
  "PRECISION",
  "TIME",
  "TIMESTAMP",
  "VARYING",
  "WITH",
  "WITHOUT",
  "ZONE",
]);

class Parser {
  readonly #source: string;
  readonly #cursor: TokenCursor;

  constructor(source: string, options: ParseOptions) {
    this.#source = source;
    this.#cursor = new TokenCursor(tokenize(source, options), {
      maxDepth: options.maxDepth ?? DEFAULT_MAX_PARSE_DEPTH,
    });
  }

  parse(): Statement {
    const statement = this.#parseStatement();
    this.#matchPunctuation(";");
    this.#expect("eof", "end of query");
    return statement;
  }

  #parseStatement(): Statement {
    return this.#nested(() => {
      const withClause = this.#current().value === "WITH" ? this.#parseWithClause() : undefined;
      if (this.#current().value === "SELECT") return this.#parseSelect(withClause);
      if (this.#current().value === "TABLE") return this.#parseTableQuery(withClause);
      if (this.#current().value === "VALUES") return this.#parseValuesQuery(withClause);
      if (withClause === undefined && this.#current().value === "(") {
        const statement = this.#parseParenthesizedSelect();
        return this.#parseSelectTail(this.#parseCompoundExpression(statement, 0));
      }
      if (this.#current().value === "INSERT" || this.#current().value === "REPLACE") {
        if (withClause !== undefined) {
          throw this.#error(
            "MySQL INSERT and REPLACE place WITH immediately before their query source",
            withClause.range,
            "TSQ401",
          );
        }
        return this.#parseInsert();
      }
      if (this.#current().value === "UPDATE") return this.#parseUpdate(withClause);
      if (this.#current().value === "DELETE") return this.#parseDelete(withClause);
      throw this.#error(
        `Expected SELECT, INSERT, REPLACE, UPDATE, or DELETE, found ${this.#current().text || "end of query"}`,
        this.#current().range,
      );
    });
  }

  #parseWithClause(): WithClause {
    const start = this.#expectKeyword("WITH").range;
    const recursive = this.#matchKeyword("RECURSIVE");
    const queries: CommonTableExpression[] = [];
    do {
      const name = this.#parseIdentifier();
      const columns: Identifier[] = [];
      if (this.#matchPunctuation("(")) {
        if (!this.#matchPunctuation(")")) {
          do columns.push(this.#parseIdentifier());
          while (this.#matchPunctuation(","));
          this.#expectPunctuation(")");
        }
      }
      this.#expectKeyword("AS");
      this.#expectPunctuation("(");
      const statement = this.#parseStatement();
      const close = this.#expectPunctuation(")");
      queries.push({ name, columns, statement, range: mergeRanges(name.range, close.range) });
    } while (this.#matchPunctuation(","));
    return { recursive, queries, range: mergeRanges(start, queries.at(-1)?.range ?? start) };
  }

  #parseSelect(withClause?: WithClause, minimumCompoundPrecedence = 0): SelectStatement {
    const start = withClause?.range ?? this.#current().range;
    this.#expectKeyword("SELECT");
    let distinct = false;
    const distinctOn: Expression[] = [];
    if (this.#matchKeyword("DISTINCT")) {
      distinct = true;
      if (this.#matchKeyword("ON")) {
        this.#expectPunctuation("(");
        distinctOn.push(...this.#parseExpressionList());
        this.#expectPunctuation(")");
      }
    } else this.#matchKeyword("ALL");
    const columns = this.#parseSelectList();
    let from: TableReference | undefined;
    const joins: JoinClause[] = [];
    let where: Expression | undefined;
    const groupBy: Expression[] = [];
    let groupRollup = false;
    let having: Expression | undefined;
    const windows: NamedWindow[] = [];

    if (this.#matchKeyword("FROM")) {
      from = this.#parseTableReference();
      while (true) {
        if (this.#matchPunctuation(",")) {
          const table = this.#parseTableReference();
          joins.push({ kind: "cross", table, range: table.range });
        } else if (this.#isJoinStart()) joins.push(this.#parseJoin());
        else break;
      }
    }
    if (this.#matchKeyword("WHERE")) where = this.#parseExpression();
    if (this.#matchKeyword("GROUP")) {
      this.#expectKeyword("BY");
      if (this.#matchKeyword("ROLLUP")) {
        groupRollup = true;
        this.#expectPunctuation("(");
        groupBy.push(...this.#parseExpressionList());
        this.#expectPunctuation(")");
      } else groupBy.push(...this.#parseExpressionList());
      if (!groupRollup && this.#matchKeyword("WITH")) {
        this.#expectKeyword("ROLLUP");
        groupRollup = true;
      }
    }
    if (this.#matchKeyword("HAVING")) having = this.#parseExpression();
    if (this.#matchKeyword("WINDOW")) {
      do {
        const name = this.#parseIdentifier();
        this.#expectKeyword("AS");
        const specification = this.#parseWindowSpecification();
        windows.push({ name, specification, range: mergeRanges(name.range, specification.range) });
      } while (this.#matchPunctuation(","));
    }
    const end = this.#previous().range;
    const core: SelectStatement = {
      kind: "select",
      ...(withClause === undefined ? {} : { with: withClause }),
      distinct,
      distinctOn,
      columns,
      ...(from === undefined ? {} : { from }),
      joins,
      ...(where === undefined ? {} : { where }),
      groupBy,
      ...(groupRollup ? { groupRollup: true as const } : {}),
      ...(having === undefined ? {} : { having }),
      windows,
      orderBy: [],
      locking: [],
      compounds: [],
      range: mergeRanges(start, end),
    };
    const compound = this.#parseCompoundExpression(core, minimumCompoundPrecedence);
    return minimumCompoundPrecedence === 0 ? this.#parseSelectTail(compound) : compound;
  }

  #parseParenthesizedSelect(): SelectStatement {
    const open = this.#expectPunctuation("(");
    const statement = this.#parseStatement();
    if (statement.kind !== "select") throw this.#error("A compound query operand must be a SELECT", statement.range);
    const close = this.#expectPunctuation(")");
    return { ...statement, parenthesized: true, range: mergeRanges(open.range, close.range) };
  }

  #parseTableQuery(withClause?: WithClause, minimumCompoundPrecedence = 0): SelectStatement {
    const start = withClause?.range ?? this.#expectKeyword("TABLE").range;
    if (withClause !== undefined) this.#expectKeyword("TABLE");
    const table = this.#parseNamedTableReference(false);
    const star: Expression = { kind: "star", range: table.range };
    const core: SelectStatement = {
      kind: "select",
      ...(withClause === undefined ? {} : { with: withClause }),
      distinct: false,
      distinctOn: [],
      columns: [{ expression: star, range: star.range }],
      from: table,
      joins: [],
      groupBy: [],
      windows: [],
      orderBy: [],
      locking: [],
      compounds: [],
      range: mergeRanges(start, table.range),
    };
    const compound = this.#parseCompoundExpression(core, minimumCompoundPrecedence);
    return minimumCompoundPrecedence === 0 ? this.#parseSelectTail(compound) : compound;
  }

  #parseValuesQuery(withClause?: WithClause, minimumCompoundPrecedence = 0): SelectStatement {
    const start = withClause?.range ?? this.#expectKeyword("VALUES").range;
    if (withClause !== undefined) this.#expectKeyword("VALUES");
    const rows: Expression[][] = [];
    do {
      this.#expectKeyword("ROW");
      this.#expectPunctuation("(");
      const row = this.#matchPunctuation(")") ? [] : [...this.#parseExpressionList()];
      if (this.#previous().value !== ")") this.#expectPunctuation(")");
      rows.push(row);
    } while (this.#matchPunctuation(","));
    const queryValues: ValuesClause = {
      kind: "values",
      rows,
      range: mergeRanges(start, this.#previous().range),
    };
    const core: SelectStatement = {
      kind: "select",
      ...(withClause === undefined ? {} : { with: withClause }),
      queryValues,
      distinct: false,
      distinctOn: [],
      columns: [],
      joins: [],
      groupBy: [],
      windows: [],
      orderBy: [],
      locking: [],
      compounds: [],
      range: queryValues.range,
    };
    const compound = this.#parseCompoundExpression(core, minimumCompoundPrecedence);
    return minimumCompoundPrecedence === 0 ? this.#parseSelectTail(compound) : compound;
  }

  #parseCompoundExpression(initial: SelectStatement, minimumPrecedence: number): SelectStatement {
    let statement = initial;
    while (["UNION", "INTERSECT", "EXCEPT"].includes(this.#current().value)) {
      const compoundPrecedence = this.#current().value === "INTERSECT" ? 2 : 1;
      if (compoundPrecedence < minimumPrecedence) break;
      const operatorToken = this.#current();
      this.#advance();
      const all = this.#matchKeyword("ALL");
      if (!all) this.#matchKeyword("DISTINCT");
      const right =
        this.#current().value === "("
          ? this.#parseParenthesizedSelect()
          : this.#current().value === "TABLE"
            ? this.#parseTableQuery(undefined, compoundPrecedence + 1)
            : this.#current().value === "VALUES"
              ? this.#parseValuesQuery(undefined, compoundPrecedence + 1)
              : this.#parseSelect(undefined, compoundPrecedence + 1);
      const compound: CompoundSelect = {
        operator: operatorToken.value.toLowerCase() as CompoundSelect["operator"],
        all,
        statement: right,
        range: mergeRanges(operatorToken.range, right.range),
      };
      statement = {
        ...statement,
        compounds: [...statement.compounds, compound],
        range: mergeRanges(statement.range, right.range),
      };
    }
    return statement;
  }

  #parseSelectTail(statement: SelectStatement): SelectStatement {
    let orderBy: OrderByItem[] = [];
    let limit: Expression | undefined;
    let offset: Expression | undefined;
    const locking: SelectLockingClause[] = [];
    if (this.#matchKeyword("ORDER")) {
      this.#expectKeyword("BY");
      orderBy = this.#parseOrderByList();
    }
    if (this.#matchKeyword("LIMIT")) {
      limit = this.#parseExpression();
      if (this.#matchPunctuation(",")) {
        offset = limit;
        limit = this.#parseExpression();
      }
    }
    if (this.#matchKeyword("OFFSET")) offset = this.#parseExpression();
    while (this.#current().value === "FOR") locking.push(this.#parseSelectLockingClause());
    if (this.#current().value === "LOCK") {
      if (locking.length > 0) {
        throw this.#error("LOCK IN SHARE MODE cannot follow another MySQL locking clause", this.#current().range);
      }
      const lockStart = this.#expectKeyword("LOCK").range;
      this.#expectKeyword("IN");
      this.#expectKeyword("SHARE");
      const lockEnd = this.#expectKeyword("MODE").range;
      locking.push({ strength: "share", relations: [], range: mergeRanges(lockStart, lockEnd) });
    }
    return {
      ...statement,
      orderBy,
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
      locking,
      range: mergeRanges(statement.range, this.#previous().range),
    };
  }

  #parseSelectLockingClause(): SelectLockingClause {
    const start = this.#expectKeyword("FOR").range;
    let strength: SelectLockingClause["strength"];
    if (this.#matchKeyword("UPDATE")) strength = "update";
    else if (this.#matchKeyword("SHARE")) strength = "share";
    else if (this.#matchKeyword("NO")) {
      throw this.#error("MySQL does not support FOR NO KEY UPDATE", start);
    } else if (this.#matchKeyword("KEY")) {
      throw this.#error("MySQL does not support FOR KEY SHARE", start);
    } else {
      throw this.#error("Expected UPDATE, NO KEY UPDATE, SHARE, or KEY SHARE after FOR", this.#current().range);
    }
    const relations: Identifier[] = [];
    if (this.#matchKeyword("OF")) {
      do relations.push(this.#parseIdentifier());
      while (this.#matchPunctuation(","));
    }
    let wait: SelectLockingClause["wait"];
    if (this.#matchKeyword("NOWAIT")) wait = "nowait";
    else if (this.#matchKeyword("SKIP")) {
      this.#expectKeyword("LOCKED");
      wait = "skip-locked";
    }
    return {
      strength,
      relations,
      ...(wait === undefined ? {} : { wait }),
      range: mergeRanges(start, this.#previous().range),
    };
  }

  #parseInsert(withClause?: WithClause): InsertStatement {
    const operation = this.#current().value === "REPLACE" ? "replace" : "insert";
    const start = withClause?.range ?? this.#expectKeyword(operation.toUpperCase()).range;
    if (withClause !== undefined) this.#expectKeyword(operation.toUpperCase());
    const priority = this.#parseDmlPriority();
    const ignore = operation === "insert" && this.#matchKeyword("IGNORE");
    this.#matchKeyword("INTO");
    const table = this.#parseNamedTableReference(false);
    const columns: Identifier[] = [];
    const columnList = this.#matchPunctuation("(");
    if (columnList) {
      if (!this.#matchPunctuation(")")) {
        do columns.push(this.#parseIdentifier());
        while (this.#matchPunctuation(","));
        this.#expectPunctuation(")");
      }
    }
    let source: InsertStatement["source"];
    let valuesRowConstructor: boolean | undefined;
    if (this.#matchKeyword("DEFAULT")) {
      const sourceStart = this.#previous().range;
      const end = this.#expectKeyword("VALUES").range;
      source = { kind: "default-values", range: mergeRanges(sourceStart, end) };
    } else if (this.#matchKeyword("VALUES") || this.#matchContextWord("VALUE")) {
      const sourceStart = this.#previous().range;
      const rows: Expression[][] = [];
      do {
        const rowConstructor = this.#matchKeyword("ROW");
        if (valuesRowConstructor !== undefined && valuesRowConstructor !== rowConstructor) {
          throw this.#error("VALUES rows must use one consistent constructor form", this.#current().range, "TSQ224");
        }
        valuesRowConstructor = rowConstructor;
        this.#expectPunctuation("(");
        const row = this.#matchPunctuation(")") ? [] : [...this.#parseExpressionList()];
        if (this.#previous().value !== ")") this.#expectPunctuation(")");
        rows.push(row);
      } while (this.#matchPunctuation(","));
      source = { kind: "values", rows, range: mergeRanges(sourceStart, this.#previous().range) };
    } else if (this.#matchKeyword("SET")) {
      const sourceStart = this.#previous().range;
      const assignments = this.#parseAssignments();
      source = {
        kind: "set",
        assignments,
        range: mergeRanges(sourceStart, assignments.at(-1)?.range ?? sourceStart),
      };
    } else if (["SELECT", "TABLE", "WITH"].includes(this.#current().value)) {
      const statement = this.#parseStatement();
      if (statement.kind !== "select") throw this.#error("INSERT source must be SELECT or VALUES", statement.range);
      source = statement;
    } else
      throw this.#error(
        "Expected VALUES, SET, DEFAULT VALUES, SELECT, or TABLE after DML target",
        this.#current().range,
      );
    if (operation === "replace" && priority === "high") {
      throw this.#error("REPLACE does not support HIGH_PRIORITY", start, "TSQ224");
    }
    if (priority === "delayed" && source.kind === "select") {
      throw this.#error(`${operation.toUpperCase()} DELAYED does not support a query source`, source.range, "TSQ224");
    }
    let rowAlias: Identifier | undefined;
    const columnAliases: Identifier[] = [];
    if (this.#matchKeyword("AS")) {
      if ((source.kind !== "values" && source.kind !== "set") || valuesRowConstructor === true) {
        throw this.#error("Inserted-row aliases apply only to VALUES or SET sources", this.#previous().range, "TSQ224");
      }
      rowAlias = this.#parseIdentifier();
      if (this.#matchPunctuation("(")) {
        if (this.#matchPunctuation(")")) {
          throw this.#error("An inserted-row column alias list cannot be empty", this.#previous().range, "TSQ224");
        }
        do columnAliases.push(this.#parseIdentifier());
        while (this.#matchPunctuation(","));
        this.#expectPunctuation(")");
      }
    }
    let duplicateKey: readonly UpdateAssignment[] = [];
    if (this.#matchKeyword("ON")) {
      if (operation === "replace") {
        throw this.#error("REPLACE cannot use ON DUPLICATE KEY UPDATE", this.#previous().range, "TSQ224");
      }
      this.#expectKeyword("DUPLICATE");
      this.#expectKeyword("KEY");
      this.#expectKeyword("UPDATE");
      duplicateKey = this.#parseAssignments();
    }
    const returning = this.#matchKeyword("RETURNING") ? this.#parseSelectList() : [];
    return {
      kind: "insert",
      operation,
      ...(withClause === undefined ? {} : { with: withClause }),
      table,
      ...(priority === undefined ? {} : { priority }),
      ignore,
      columnList,
      columns,
      source,
      ...(rowAlias === undefined ? {} : { rowAlias }),
      columnAliases,
      duplicateKey,
      returning,
      range: mergeRanges(start, this.#previous().range),
    };
  }

  #parseUpdate(withClause?: WithClause): UpdateStatement {
    const start = withClause?.range ?? this.#expectKeyword("UPDATE").range;
    if (withClause !== undefined) this.#expectKeyword("UPDATE");
    const priority = this.#matchKeyword("LOW_PRIORITY") ? "low" : undefined;
    const ignore = this.#matchKeyword("IGNORE");
    const table = this.#parseTableReference();
    const joins = this.#parseFollowingTableReferences();
    this.#expectKeyword("SET");
    const assignments = this.#parseAssignments();
    if (this.#current().value === "FROM") {
      throw this.#error(
        "MySQL uses joined table references before SET instead of UPDATE FROM",
        this.#current().range,
        "TSQ401",
      );
    }
    const where = this.#matchKeyword("WHERE") ? this.#parseExpression() : undefined;
    let orderBy: readonly OrderByItem[] = [];
    if (this.#matchKeyword("ORDER")) {
      this.#expectKeyword("BY");
      orderBy = this.#parseOrderByList();
    }
    const limit = this.#matchKeyword("LIMIT") ? this.#parseExpression() : undefined;
    const returning = this.#matchKeyword("RETURNING") ? this.#parseSelectList() : [];
    return {
      kind: "update",
      ...(withClause === undefined ? {} : { with: withClause }),
      table,
      ...(priority === undefined ? {} : { priority }),
      ignore,
      assignments,
      joins,
      ...(where === undefined ? {} : { where }),
      orderBy,
      ...(limit === undefined ? {} : { limit }),
      returning,
      range: mergeRanges(start, this.#previous().range),
    };
  }

  #parseDelete(withClause?: WithClause): DeleteStatement {
    const start = withClause?.range ?? this.#expectKeyword("DELETE").range;
    if (withClause !== undefined) this.#expectKeyword("DELETE");
    const priority = this.#matchKeyword("LOW_PRIORITY") ? "low" : undefined;
    const quick = this.#matchKeyword("QUICK");
    const ignore = this.#matchKeyword("IGNORE");
    const targets: Identifier[] = [];
    let table: TableReference;
    let joins: readonly JoinClause[] = [];
    let multiTable = false;
    if (this.#matchKeyword("FROM")) {
      let first = this.#parseNamedTableReference(true);
      if (this.#current().value === "USING" || this.#current().value === ",") {
        targets.push(first.name);
        while (this.#matchPunctuation(",")) targets.push(this.#parseDeleteTarget());
        this.#expectKeyword("USING");
        table = this.#parseTableReference();
        joins = this.#parseFollowingTableReferences();
        multiTable = true;
      } else {
        if (this.#current().value === "PARTITION") {
          first = { ...first, partitions: this.#parsePartitions() };
        }
        table = first;
        targets.push(first.alias ?? first.name);
      }
    } else {
      do targets.push(this.#parseDeleteTarget());
      while (this.#matchPunctuation(","));
      this.#expectKeyword("FROM");
      table = this.#parseTableReference();
      joins = this.#parseFollowingTableReferences();
      multiTable = true;
    }
    const where = this.#matchKeyword("WHERE") ? this.#parseExpression() : undefined;
    let orderBy: readonly OrderByItem[] = [];
    if (this.#matchKeyword("ORDER")) {
      this.#expectKeyword("BY");
      orderBy = this.#parseOrderByList();
    }
    const limit = this.#matchKeyword("LIMIT") ? this.#parseExpression() : undefined;
    const returning = this.#matchKeyword("RETURNING") ? this.#parseSelectList() : [];
    return {
      kind: "delete",
      ...(withClause === undefined ? {} : { with: withClause }),
      table,
      targets,
      ...(priority === undefined ? {} : { priority }),
      quick,
      ignore,
      multiTable,
      joins,
      ...(where === undefined ? {} : { where }),
      orderBy,
      ...(limit === undefined ? {} : { limit }),
      returning,
      range: mergeRanges(start, this.#previous().range),
    };
  }

  #parseDmlPriority(): "low" | "delayed" | "high" | undefined {
    if (this.#matchKeyword("LOW_PRIORITY")) return "low";
    if (this.#matchKeyword("DELAYED")) return "delayed";
    if (this.#matchKeyword("HIGH_PRIORITY")) return "high";
    return undefined;
  }

  #parseAssignmentColumn(): Extract<Expression, { readonly kind: "column" }> {
    const first = this.#parseIdentifier();
    if (!this.#matchPunctuation(".")) return { kind: "column", column: first, range: first.range };
    const column = this.#parseIdentifier();
    return { kind: "column", relation: first, column, range: mergeRanges(first.range, column.range) };
  }

  #parseAssignments(): readonly UpdateAssignment[] {
    const assignments: UpdateAssignment[] = [];
    do {
      const column = this.#parseAssignmentColumn();
      this.#expectOperator("=");
      const value = this.#parseExpression();
      assignments.push({ column, value, range: mergeRanges(column.range, value.range) });
    } while (this.#matchPunctuation(","));
    return assignments;
  }

  #parseFollowingTableReferences(): readonly JoinClause[] {
    const joins: JoinClause[] = [];
    while (true) {
      if (this.#matchPunctuation(",")) {
        const table = this.#parseTableReference();
        joins.push({ kind: "cross", table, range: table.range });
      } else if (this.#isJoinStart()) joins.push(this.#parseJoin());
      else break;
    }
    return joins;
  }

  #parseDeleteTarget(): Identifier {
    const target = this.#parseIdentifier();
    if (this.#matchPunctuation(".")) this.#expectOperator("*");
    return target;
  }

  #parseSelectList(): readonly SelectItem[] {
    const items: SelectItem[] = [];
    do {
      const expression = this.#parseExpression();
      let alias: Identifier | undefined;
      if (this.#matchKeyword("AS")) alias = this.#parseIdentifier();
      else if (this.#current().kind === "identifier" || this.#current().kind === "quoted-identifier")
        alias = this.#parseIdentifier();
      items.push({
        expression,
        ...(alias === undefined ? {} : { alias }),
        range: mergeRanges(expression.range, alias?.range ?? expression.range),
      });
    } while (this.#matchPunctuation(","));
    return items;
  }

  #parseTableReference(): TableReference {
    const lateral = this.#matchKeyword("LATERAL");
    const start = lateral ? this.#previous().range : this.#current().range;
    if (this.#matchPunctuation("(")) {
      if (!this.#isStatementStart()) {
        throw this.#error("A parenthesized FROM item must be a SELECT subquery", this.#current().range);
      }
      const statement = this.#parseStatement();
      if (statement.kind !== "select") throw this.#error("FROM subquery must be SELECT", statement.range);
      this.#expectPunctuation(")");
      this.#matchKeyword("AS");
      const alias = this.#parseIdentifier();
      return { kind: "subquery", query: statement, alias, lateral, range: mergeRanges(start, alias.range) };
    }
    if (lateral) {
      throw this.#error("MySQL LATERAL applies only to derived-table subqueries", start, "TSQ401");
    }
    return this.#parseNamedTableReference(true, lateral, start);
  }

  #parseNamedTableReference(allowAlias: boolean, lateral = false, start = this.#current().range): NamedTableReference {
    const first = this.#parseIdentifier();
    let schema: Identifier | undefined;
    let name = first;
    if (this.#matchPunctuation(".")) {
      schema = first;
      name = this.#parseIdentifier();
    }
    const partitions = this.#current().value === "PARTITION" ? this.#parsePartitions() : [];
    let alias: Identifier | undefined;
    if (allowAlias && this.#matchKeyword("AS")) alias = this.#parseIdentifier();
    else if (allowAlias && (this.#current().kind === "identifier" || this.#current().kind === "quoted-identifier"))
      alias = this.#parseIdentifier();
    return {
      kind: "table",
      name,
      ...(schema === undefined ? {} : { schema }),
      ...(partitions.length === 0 ? {} : { partitions }),
      ...(alias === undefined ? {} : { alias }),
      lateral,
      range: mergeRanges(start, alias?.range ?? partitions.at(-1)?.range ?? name.range),
    };
  }

  #parsePartitions(): readonly Identifier[] {
    this.#expectKeyword("PARTITION");
    this.#expectPunctuation("(");
    const partitions: Identifier[] = [];
    do partitions.push(this.#parseIdentifier());
    while (this.#matchPunctuation(","));
    this.#expectPunctuation(")");
    return partitions;
  }

  #isJoinStart(): boolean {
    return ["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS"].includes(this.#current().value);
  }

  #parseJoin(): JoinClause {
    const start = this.#current().range;
    let kind: JoinKind = "inner";
    if (this.#matchKeyword("INNER")) kind = "inner";
    else if (this.#matchKeyword("LEFT")) kind = "left";
    else if (this.#matchKeyword("RIGHT")) kind = "right";
    else if (this.#matchKeyword("FULL")) kind = "full";
    else if (this.#matchKeyword("CROSS")) kind = "cross";
    this.#matchKeyword("OUTER");
    this.#expectKeyword("JOIN");
    const table = this.#parseTableReference();
    if (kind === "cross") return { kind, table, range: mergeRanges(start, table.range) };
    if (this.#matchKeyword("ON")) {
      const on = this.#parseExpression();
      return { kind, table, on, range: mergeRanges(start, on.range) };
    }
    if (this.#matchKeyword("USING")) {
      this.#expectPunctuation("(");
      const using: Identifier[] = [];
      do using.push(this.#parseIdentifier());
      while (this.#matchPunctuation(","));
      const close = this.#expectPunctuation(")");
      return { kind, table, using, range: mergeRanges(start, close.range) };
    }
    throw this.#error("JOIN requires ON or USING", this.#current().range);
  }

  #parseExpressionList(): readonly Expression[] {
    const expressions: Expression[] = [];
    do expressions.push(this.#parseExpression());
    while (this.#matchPunctuation(","));
    return expressions;
  }

  #parseOrderByList(): OrderByItem[] {
    const orderBy: OrderByItem[] = [];
    do {
      const expression = this.#parseExpression();
      const direction = this.#matchKeyword("ASC") ? "asc" : this.#matchKeyword("DESC") ? "desc" : undefined;
      let nulls: "first" | "last" | undefined;
      if (this.#matchKeyword("NULLS")) {
        if (this.#matchKeyword("FIRST")) nulls = "first";
        else {
          this.#expectKeyword("LAST");
          nulls = "last";
        }
      }
      orderBy.push({
        expression,
        ...(direction === undefined ? {} : { direction }),
        ...(nulls === undefined ? {} : { nulls }),
        range: mergeRanges(expression.range, this.#previous().range),
      });
    } while (this.#matchPunctuation(","));
    return orderBy;
  }

  #parseExpression(minimum = 0): Expression {
    return this.#nested(() => {
      let left = this.#parseUnary();
      while (true) {
        const negated = this.#current().value === "NOT" && ["IN", "BETWEEN", "LIKE"].includes(this.#peekToken(1).value);
        const special = negated ? this.#peekToken(1).value : this.#current().value;
        if (special === "IN") {
          const strength = 4;
          if (strength < minimum) break;
          if (negated) this.#advance();
          this.#advance();
          const start = left.range;
          this.#expectPunctuation("(");
          let values: readonly Expression[] | SelectStatement;
          if (this.#isStatementStart()) {
            const statement = this.#parseStatement();
            if (statement.kind !== "select") throw this.#error("IN subquery must be SELECT", statement.range);
            values = statement;
          } else {
            if (this.#current().value === ")")
              throw this.#error("IN requires at least one value", this.#current().range);
            values = this.#parseExpressionList();
          }
          const close = this.#previous().value === ")" ? this.#previous() : this.#expectPunctuation(")");
          left = { kind: "in", expression: left, values, negated, range: mergeRanges(start, close.range) };
          continue;
        }
        if (special === "BETWEEN") {
          const strength = 4;
          if (strength < minimum) break;
          if (negated) this.#advance();
          this.#advance();
          const lower = this.#parseExpression(strength + 1);
          this.#expectKeyword("AND");
          const upper = this.#parseExpression(strength + 1);
          left = {
            kind: "between",
            expression: left,
            lower,
            upper,
            negated,
            range: mergeRanges(left.range, upper.range),
          } satisfies BetweenExpression;
          continue;
        }

        let operator = this.#current().value.toUpperCase();
        if (negated) operator = `NOT ${special}`;
        const strength = precedence.get(operator.replace(/^NOT /u, ""));
        if (strength === undefined || strength < minimum) break;
        if (negated) this.#advance();
        this.#advance();
        if (operator === "IS") {
          if (this.#matchKeyword("NOT")) operator = "IS NOT";
        }
        const right = this.#parseExpression(strength + 1);
        left = { kind: "binary", left, operator, right, range: mergeRanges(left.range, right.range) };
      }
      return left;
    });
  }

  #parseUnary(): Expression {
    const token = this.#current();
    if (
      this.#matchKeyword("NOT") ||
      this.#matchOperator("!") ||
      this.#matchOperator("+") ||
      this.#matchOperator("-") ||
      this.#matchOperator("~")
    ) {
      const expression = this.#parseUnary();
      return {
        kind: "unary",
        operator: token.value === "!" ? "NOT" : token.value.toUpperCase(),
        expression,
        range: mergeRanges(token.range, expression.range),
      };
    }
    if (this.#matchKeyword("EXISTS")) {
      this.#expectPunctuation("(");
      const statement = this.#parseStatement();
      if (statement.kind !== "select") throw this.#error("EXISTS requires a SELECT subquery", statement.range);
      const close = this.#expectPunctuation(")");
      return { kind: "exists", query: statement, range: mergeRanges(token.range, close.range) };
    }
    let expression = this.#parsePrimary();
    while (this.#matchKeyword("COLLATE")) {
      const collation = this.#parseIdentifier(true);
      expression = {
        kind: "collate",
        expression,
        collation,
        range: mergeRanges(expression.range, collation.range),
      };
    }
    return expression;
  }

  #parsePrimary(): Expression {
    const token = this.#current();
    if (this.#matchPunctuation("(")) {
      if (this.#isStatementStart()) {
        const statement = this.#parseStatement();
        if (statement.kind !== "select") throw this.#error("Scalar subquery must be SELECT", statement.range);
        const close = this.#expectPunctuation(")");
        return { kind: "subquery", query: statement, range: mergeRanges(token.range, close.range) };
      }
      const first = this.#parseExpression();
      if (this.#matchPunctuation(",")) {
        const elements = [first];
        do elements.push(this.#parseExpression());
        while (this.#matchPunctuation(","));
        const close = this.#expectPunctuation(")");
        return { kind: "row", elements, range: mergeRanges(token.range, close.range) };
      }
      this.#expectPunctuation(")");
      return first;
    }
    if (this.#matchKeyword("ARRAY")) {
      this.#expectPunctuation("[");
      const elements = this.#matchPunctuation("]") ? [] : [...this.#parseExpressionList()];
      const close = this.#previous().value === "]" ? this.#previous() : this.#expectPunctuation("]");
      return { kind: "array", elements, range: mergeRanges(token.range, close.range) };
    }
    if (this.#matchKeyword("ROW")) {
      this.#expectPunctuation("(");
      const elements = this.#matchPunctuation(")") ? [] : [...this.#parseExpressionList()];
      const close = this.#previous().value === ")" ? this.#previous() : this.#expectPunctuation(")");
      return { kind: "row", elements, range: mergeRanges(token.range, close.range) };
    }
    if (this.#matchKeyword("CAST")) return this.#parseCast(token.range);
    if (this.#matchKeyword("CASE")) return this.#parseCase(token.range);
    if (this.#matchKeyword("NULL")) return { kind: "literal", value: null, range: token.range };
    if (this.#matchKeyword("TRUE")) return { kind: "literal", value: true, range: token.range };
    if (this.#matchKeyword("FALSE")) return { kind: "literal", value: false, range: token.range };
    if (this.#matchKeyword("DEFAULT"))
      return { kind: "column", column: { name: "DEFAULT", quoted: false, range: token.range }, range: token.range };
    if (token.kind === "number") {
      this.#advance();
      return {
        kind: "literal",
        value: Number(token.value),
        range: token.range,
      };
    }
    if (token.kind === "string") {
      this.#advance();
      return { kind: "literal", value: token.value, range: token.range };
    }
    if (token.kind === "parameter") {
      this.#advance();
      return { kind: "parameter", index: Number(token.value), range: token.range };
    }
    if (this.#matchOperator("*")) return { kind: "star", range: token.range };
    if (token.kind === "identifier" && token.value.startsWith("_") && this.#peekToken(1).kind === "string") {
      const characterSet = this.#parseIdentifier();
      const value = this.#current();
      this.#advance();
      return {
        kind: "literal",
        value: value.value,
        characterSet,
        range: mergeRanges(characterSet.range, value.range),
      };
    }
    if (this.#isIdentifierLike(token)) {
      const first = this.#parseIdentifier(true);
      if (this.#matchPunctuation("(")) return this.#parseCall(undefined, first);
      if (this.#matchPunctuation(".")) {
        if (this.#matchOperator("*"))
          return { kind: "star", relation: first, range: mergeRanges(first.range, this.#previous().range) };
        const second = this.#parseIdentifier(true);
        if (this.#matchPunctuation("(")) return this.#parseCall(first, second);
        return { kind: "column", relation: first, column: second, range: mergeRanges(first.range, second.range) };
      }
      return { kind: "column", column: first, range: first.range };
    }
    throw this.#error(`Expected expression, found ${token.text || "end of query"}`, token.range);
  }

  #parseCall(schema: Identifier | undefined, name: Identifier): Expression {
    const distinct = this.#matchKeyword("DISTINCT");
    const args: Expression[] = [];
    let close: Token;
    if (this.#matchPunctuation(")")) close = this.#previous();
    else {
      do args.push(this.#parseExpression());
      while (this.#matchPunctuation(","));
      close = this.#expectPunctuation(")");
    }
    const filter: Expression | undefined = undefined;
    if (this.#current().value === "FROM" && ["FIRST", "LAST"].includes(this.#peekToken(1).value)) {
      this.#advance();
      if (this.#matchKeyword("LAST")) {
        throw this.#error("MySQL does not support FROM LAST for window functions", this.#previous().range, "TSQ401");
      }
      this.#expectKeyword("FIRST");
    }
    if (this.#matchKeyword("IGNORE")) {
      const nulls = this.#expectKeyword("NULLS");
      throw this.#error("MySQL supports only RESPECT NULLS for window functions", nulls.range, "TSQ401");
    }
    if (this.#matchKeyword("RESPECT")) this.#expectKeyword("NULLS");
    let over: Identifier | WindowSpecification | undefined;
    if (this.#matchKeyword("OVER")) {
      if (this.#current().kind === "identifier" || this.#current().kind === "quoted-identifier")
        over = this.#parseIdentifier();
      else over = this.#parseWindowSpecification();
      close = { ...close, range: over.range };
    }
    return {
      kind: "call",
      name,
      ...(schema === undefined ? {} : { schema }),
      arguments: args,
      distinct,
      ...(filter === undefined ? {} : { filter }),
      ...(over === undefined ? {} : { over }),
      range: mergeRanges(schema?.range ?? name.range, close.range),
    };
  }

  #parseWindowSpecification(): WindowSpecification {
    const start = this.#expectPunctuation("(").range;
    const base =
      this.#isIdentifierLike(this.#current()) &&
      !["PARTITION", "ORDER", "ROWS", "RANGE"].includes(this.#current().value)
        ? this.#parseIdentifier()
        : undefined;
    const partitionBy: Expression[] = [];
    let orderBy: OrderByItem[] = [];
    let frame: WindowSpecification["frame"];
    if (this.#matchKeyword("PARTITION")) {
      this.#expectKeyword("BY");
      partitionBy.push(...this.#parseExpressionList());
    }
    if (this.#matchKeyword("ORDER")) {
      this.#expectKeyword("BY");
      orderBy = this.#parseOrderByList();
    }
    if (this.#current().value === "ROWS" || this.#current().value === "RANGE") {
      const frameStart = this.#current();
      this.#advance();
      const unit = frameStart.value.toLowerCase() as "rows" | "range";
      let first: WindowFrameBoundary;
      let end: WindowFrameBoundary | undefined;
      if (this.#matchKeyword("BETWEEN")) {
        first = this.#parseWindowFrameBoundary();
        this.#expectKeyword("AND");
        end = this.#parseWindowFrameBoundary();
      } else first = this.#parseWindowFrameBoundary();
      frame = {
        unit,
        start: first,
        ...(end === undefined ? {} : { end }),
        range: mergeRanges(frameStart.range, end?.range ?? first.range),
      };
    }
    if (this.#current().value === "GROUPS" || this.#current().value === "EXCLUDE") {
      throw this.#error(
        `MySQL does not support ${this.#current().value} window frames`,
        this.#current().range,
        "TSQ401",
      );
    }
    const close = this.#expectPunctuation(")");
    return {
      ...(base === undefined ? {} : { base }),
      partitionBy,
      orderBy,
      ...(frame === undefined ? {} : { frame }),
      range: mergeRanges(start, close.range),
    };
  }

  #parseWindowFrameBoundary(): WindowFrameBoundary {
    const start = this.#current().range;
    if (this.#matchKeyword("UNBOUNDED")) {
      if (this.#matchKeyword("PRECEDING")) {
        return { kind: "unbounded-preceding", range: mergeRanges(start, this.#previous().range) };
      }
      this.#expectKeyword("FOLLOWING");
      return { kind: "unbounded-following", range: mergeRanges(start, this.#previous().range) };
    }
    if (this.#matchKeyword("CURRENT")) {
      const end = this.#expectKeyword("ROW").range;
      return { kind: "current-row", range: mergeRanges(start, end) };
    }
    const expression = this.#parseExpression(11);
    if (this.#matchKeyword("PRECEDING")) {
      return { kind: "preceding", expression, range: mergeRanges(start, this.#previous().range) };
    }
    this.#expectKeyword("FOLLOWING");
    return { kind: "following", expression, range: mergeRanges(start, this.#previous().range) };
  }

  #parseCast(start: SourceRange): Expression {
    this.#expectPunctuation("(");
    const expression = this.#parseExpression();
    this.#expectKeyword("AS");
    const databaseType = this.#parseTypeName(true);
    const close = this.#expectPunctuation(")");
    return { kind: "cast", expression, databaseType, syntax: "cast", range: mergeRanges(start, close.range) };
  }

  #parseTypeName(stopAtClose: boolean): TypeName {
    const start = this.#current();
    if (!this.#isIdentifierLike(start))
      throw this.#error(`Expected identifier, found ${start.text || "end of query"}`, start.range);
    this.#advance();
    let end = start;
    let schemaSeparatorAllowed = true;
    while (true) {
      if (schemaSeparatorAllowed && this.#matchPunctuation(".")) {
        this.#parseIdentifier(true);
        end = this.#previous();
        schemaSeparatorAllowed = false;
        continue;
      }
      schemaSeparatorAllowed = false;
      if (this.#matchPunctuation("(")) {
        let depth = 1;
        while (depth > 0) {
          const token = this.#current();
          if (token.kind === "eof") throw this.#error("Unterminated type modifier", token.range);
          this.#advance();
          if (token.value === "(") depth += 1;
          else if (token.value === ")") depth -= 1;
          end = token;
        }
        continue;
      }
      if (this.#isIdentifierLike(this.#current()) && typeContinuationWords.has(this.#current().value.toUpperCase())) {
        end = this.#advance();
        continue;
      }
      if (this.#matchPunctuation("[")) {
        end = this.#expectPunctuation("]");
        continue;
      }
      break;
    }
    if (stopAtClose && this.#current().value !== ")")
      throw this.#error(`Expected ) after type name, found ${this.#current().text}`, this.#current().range);
    return {
      name: this.#source.slice(start.range.start, end.range.end).trim(),
      range: mergeRanges(start.range, end.range),
    };
  }

  #parseCase(start: SourceRange): Expression {
    const operand = this.#current().value === "WHEN" ? undefined : this.#parseExpression();
    const branches: CaseBranch[] = [];
    while (this.#matchKeyword("WHEN")) {
      const whenStart = this.#previous().range;
      const when = this.#parseExpression();
      this.#expectKeyword("THEN");
      const then = this.#parseExpression();
      branches.push({ when, then, range: mergeRanges(whenStart, then.range) });
    }
    if (branches.length === 0) throw this.#error("CASE requires at least one WHEN branch", this.#current().range);
    const elseExpression = this.#matchKeyword("ELSE") ? this.#parseExpression() : undefined;
    const end = this.#expectKeyword("END");
    return {
      kind: "case",
      ...(operand === undefined ? {} : { operand }),
      branches,
      ...(elseExpression === undefined ? {} : { elseExpression }),
      range: mergeRanges(start, end.range),
    };
  }

  #parseIdentifier(allowKeyword = false): Identifier {
    const token = this.#current();
    if (!this.#isIdentifierLike(token) || (token.kind === "keyword" && !allowKeyword)) {
      throw this.#error(`Expected identifier, found ${token.text || "end of query"}`, token.range);
    }
    this.#advance();
    return { name: token.value, quoted: token.kind === "quoted-identifier", range: token.range };
  }

  #isIdentifierLike(token: Token): boolean {
    return token.kind === "identifier" || token.kind === "quoted-identifier" || token.kind === "keyword";
  }

  #isStatementStart(): boolean {
    return ["SELECT", "TABLE", "VALUES", "INSERT", "REPLACE", "UPDATE", "DELETE", "WITH"].includes(
      this.#current().value,
    );
  }

  #current(): Token {
    return this.#cursor.current();
  }

  #peekToken(offset: number): Token {
    return this.#cursor.peek(offset);
  }

  #previous(): Token {
    return this.#cursor.previous();
  }

  #advance(): Token {
    return this.#cursor.advance();
  }

  #matchKeyword(keyword: string): boolean {
    if (this.#current().kind === "keyword" && this.#current().value === keyword) {
      this.#advance();
      return true;
    }
    return false;
  }

  #matchContextWord(word: string): boolean {
    if (this.#current().value !== word) return false;
    this.#advance();
    return true;
  }

  #matchOperator(operator: string): boolean {
    if (this.#current().kind === "operator" && this.#current().value === operator) {
      this.#advance();
      return true;
    }
    return false;
  }

  #matchPunctuation(value: string): boolean {
    if (this.#current().kind === "punctuation" && this.#current().value === value) {
      this.#advance();
      return true;
    }
    return false;
  }

  #expectKeyword(keyword: string): Token {
    const token = this.#current();
    if (!this.#matchKeyword(keyword))
      throw this.#error(`Expected ${keyword}, found ${token.text || "end of query"}`, token.range);
    return token;
  }

  #expectOperator(operator: string): Token {
    const token = this.#current();
    if (!this.#matchOperator(operator))
      throw this.#error(`Expected ${operator}, found ${token.text || "end of query"}`, token.range);
    return token;
  }

  #expectPunctuation(value: string): Token {
    const token = this.#current();
    if (!this.#matchPunctuation(value))
      throw this.#error(`Expected ${value}, found ${token.text || "end of query"}`, token.range);
    return token;
  }

  #expect(kind: Token["kind"], label: string): Token {
    const token = this.#current();
    if (token.kind !== kind) throw this.#error(`Expected ${label}, found ${token.text || "end of query"}`, token.range);
    this.#advance();
    return token;
  }

  #nested<T>(fn: () => T): T {
    return this.#cursor.nested(fn);
  }

  #error(message: string, range: SourceRange, code = "TSQ001"): SqlParseError {
    return new SqlParseError(message, range, code);
  }
}

function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function parse(source: string, options: ParseOptions): Statement {
  try {
    return deepFreeze(new Parser(source, options).parse());
  } catch (error) {
    if (error instanceof SqlTokenizeError) throw new SqlParseError(error.message, error.range, error.code);
    if (error instanceof SqlToolkitError) throw new SqlParseError(error.message, error.range, error.code);
    throw error;
  }
}

export function parseStatement(source: string, options: ParseOptions = {}): Statement {
  return parse(source, options);
}

export function parseSelect(source: string, options: ParseOptions = {}): SelectStatement {
  const statement = parse(source, options);
  if (statement.kind !== "select")
    throw new SqlParseError(`Expected SELECT, found ${statement.kind.toUpperCase()}`, statement.range);
  return statement;
}
