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
      if (this.#current().value === "INSERT") return this.#parseInsert(withClause);
      if (this.#current().value === "UPDATE") return this.#parseUpdate(withClause);
      if (this.#current().value === "DELETE") return this.#parseDelete(withClause);
      throw this.#error(
        `Expected SELECT, INSERT, UPDATE, or DELETE, found ${this.#current().text || "end of query"}`,
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

  #parseSelect(withClause?: WithClause): SelectStatement {
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
    let having: Expression | undefined;
    const windows: NamedWindow[] = [];
    let orderBy: OrderByItem[] = [];
    let limit: Expression | undefined;
    let offset: Expression | undefined;
    const locking: SelectLockingClause[] = [];
    const compounds: CompoundSelect[] = [];

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
      groupBy.push(...this.#parseExpressionList());
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

    if (["UNION", "INTERSECT", "EXCEPT"].includes(this.#current().value)) {
      if (orderBy.length > 0 || limit !== undefined || offset !== undefined || locking.length > 0) {
        throw this.#error(
          "ORDER BY, LIMIT, OFFSET, and locking clauses must follow the final compound SELECT",
          this.#current().range,
        );
      }
      const operatorToken = this.#current();
      this.#advance();
      const all = this.#matchKeyword("ALL");
      const parsed = this.#parseSelect();
      const {
        orderBy: trailingOrderBy,
        limit: trailingLimit,
        offset: trailingOffset,
        locking: trailingLocking,
        ...arm
      } = parsed;
      const statement: SelectStatement = { ...arm, orderBy: [], locking: [] };
      orderBy = [...trailingOrderBy];
      limit = trailingLimit;
      offset = trailingOffset;
      locking.push(...trailingLocking);
      compounds.push({
        operator: operatorToken.value.toLowerCase() as CompoundSelect["operator"],
        all,
        statement,
        range: mergeRanges(operatorToken.range, statement.range),
      });
    }

    const end = this.#previous().range;
    return {
      kind: "select",
      ...(withClause === undefined ? {} : { with: withClause }),
      distinct,
      distinctOn,
      columns,
      ...(from === undefined ? {} : { from }),
      joins,
      ...(where === undefined ? {} : { where }),
      groupBy,
      ...(having === undefined ? {} : { having }),
      windows,
      orderBy,
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
      locking,
      compounds,
      range: mergeRanges(start, end),
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
    const start = withClause?.range ?? this.#expectKeyword("INSERT").range;
    if (withClause !== undefined) this.#expectKeyword("INSERT");
    this.#expectKeyword("INTO");
    const table = this.#parseNamedTableReference(true);
    const columns: Identifier[] = [];
    if (this.#matchPunctuation("(")) {
      if (!this.#matchPunctuation(")")) {
        do columns.push(this.#parseIdentifier());
        while (this.#matchPunctuation(","));
        this.#expectPunctuation(")");
      }
    }
    let source: ValuesClause | SelectStatement | { readonly kind: "default-values"; readonly range: SourceRange };
    if (this.#matchKeyword("DEFAULT")) {
      const sourceStart = this.#previous().range;
      const end = this.#expectKeyword("VALUES").range;
      source = { kind: "default-values", range: mergeRanges(sourceStart, end) };
    } else if (this.#matchKeyword("VALUES")) {
      const sourceStart = this.#previous().range;
      const rows: Expression[][] = [];
      do {
        this.#expectPunctuation("(");
        const row = this.#matchPunctuation(")") ? [] : [...this.#parseExpressionList()];
        const close = this.#previous().value === ")" ? this.#previous() : this.#expectPunctuation(")");
        rows.push(row);
        if (close.value !== ")") throw this.#error("Expected ) after VALUES row", close.range);
      } while (this.#matchPunctuation(","));
      source = { kind: "values", rows, range: mergeRanges(sourceStart, this.#previous().range) };
    } else if (this.#current().value === "SELECT" || this.#current().value === "WITH") {
      const statement = this.#parseStatement();
      if (statement.kind !== "select") throw this.#error("INSERT source must be SELECT or VALUES", statement.range);
      source = statement;
    } else throw this.#error("Expected VALUES, DEFAULT VALUES, or SELECT after INSERT target", this.#current().range);
    const returning = this.#matchKeyword("RETURNING") ? this.#parseSelectList() : [];
    return {
      kind: "insert",
      ...(withClause === undefined ? {} : { with: withClause }),
      table,
      columns,
      source,
      returning,
      range: mergeRanges(start, this.#previous().range),
    };
  }

  #parseUpdate(withClause?: WithClause): UpdateStatement {
    const start = withClause?.range ?? this.#expectKeyword("UPDATE").range;
    if (withClause !== undefined) this.#expectKeyword("UPDATE");
    const table = this.#parseNamedTableReference(true);
    this.#expectKeyword("SET");
    const assignments: UpdateAssignment[] = [];
    do {
      const column = this.#parseIdentifier();
      this.#expectOperator("=");
      const value = this.#parseExpression();
      assignments.push({ column, value, range: mergeRanges(column.range, value.range) });
    } while (this.#matchPunctuation(","));
    let from: TableReference | undefined;
    const joins: JoinClause[] = [];
    if (this.#matchKeyword("FROM")) {
      from = this.#parseTableReference();
      while (this.#isJoinStart()) joins.push(this.#parseJoin());
    }
    const where = this.#matchKeyword("WHERE") ? this.#parseExpression() : undefined;
    const returning = this.#matchKeyword("RETURNING") ? this.#parseSelectList() : [];
    return {
      kind: "update",
      ...(withClause === undefined ? {} : { with: withClause }),
      table,
      assignments,
      ...(from === undefined ? {} : { from }),
      joins,
      ...(where === undefined ? {} : { where }),
      returning,
      range: mergeRanges(start, this.#previous().range),
    };
  }

  #parseDelete(withClause?: WithClause): DeleteStatement {
    const start = withClause?.range ?? this.#expectKeyword("DELETE").range;
    if (withClause !== undefined) this.#expectKeyword("DELETE");
    this.#expectKeyword("FROM");
    const table = this.#parseNamedTableReference(true);
    const using: TableReference[] = [];
    if (this.#matchKeyword("USING")) {
      do using.push(this.#parseTableReference());
      while (this.#matchPunctuation(","));
    }
    const where = this.#matchKeyword("WHERE") ? this.#parseExpression() : undefined;
    const returning = this.#matchKeyword("RETURNING") ? this.#parseSelectList() : [];
    return {
      kind: "delete",
      ...(withClause === undefined ? {} : { with: withClause }),
      table,
      using,
      ...(where === undefined ? {} : { where }),
      returning,
      range: mergeRanges(start, this.#previous().range),
    };
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
    let alias: Identifier | undefined;
    if (allowAlias && this.#matchKeyword("AS")) alias = this.#parseIdentifier();
    else if (allowAlias && (this.#current().kind === "identifier" || this.#current().kind === "quoted-identifier"))
      alias = this.#parseIdentifier();
    return {
      kind: "table",
      name,
      ...(schema === undefined ? {} : { schema }),
      ...(alias === undefined ? {} : { alias }),
      lateral,
      range: mergeRanges(start, alias?.range ?? name.range),
    };
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
    return this.#parsePrimary();
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
      return { kind: "literal", value: Number(token.value), range: token.range };
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
    const partitionBy: Expression[] = [];
    let orderBy: OrderByItem[] = [];
    if (this.#matchKeyword("PARTITION")) {
      this.#expectKeyword("BY");
      partitionBy.push(...this.#parseExpressionList());
    }
    if (this.#matchKeyword("ORDER")) {
      this.#expectKeyword("BY");
      orderBy = this.#parseOrderByList();
    }
    const close = this.#expectPunctuation(")");
    return { partitionBy, orderBy, range: mergeRanges(start, close.range) };
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
    return ["SELECT", "INSERT", "UPDATE", "DELETE", "WITH"].includes(this.#current().value);
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
