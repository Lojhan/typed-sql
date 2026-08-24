import { SqlTokenizeError, tokenize } from "./tokenizer.js";
import {
  mergeRanges,
  type CaseBranch,
  type Expression,
  type Identifier,
  type JoinClause,
  type JoinKind,
  type OrderByItem,
  type SelectItem,
  type SelectStatement,
  type SourceRange,
  type TableReference,
  type Token,
} from "./types.js";

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
  ["OR", 1], ["AND", 2], ["=", 3], ["!=", 3], ["<>", 3], ["<", 3],
  ["<=", 3], [">", 3], [">=", 3], ["IS", 3], ["LIKE", 3],
  ["||", 4], ["+", 5], ["-", 5], ["*", 6], ["/", 6], ["%", 6],
]);

class Parser {
  readonly #tokens: readonly Token[];
  #index = 0;

  constructor(source: string) {
    this.#tokens = tokenize(source);
  }

  parseSelect(): SelectStatement {
    const start = this.#expectKeyword("SELECT").range;
    const distinct = this.#matchKeyword("DISTINCT");
    const columns = this.#parseSelectList();
    let from: TableReference | undefined;
    const joins: JoinClause[] = [];
    let where: Expression | undefined;
    const groupBy: Expression[] = [];
    let having: Expression | undefined;
    const orderBy: OrderByItem[] = [];
    let limit: Expression | undefined;
    let offset: Expression | undefined;

    if (this.#matchKeyword("FROM")) {
      from = this.#parseTableReference();
      while (this.#isJoinStart()) joins.push(this.#parseJoin());
    }
    if (this.#matchKeyword("WHERE")) where = this.#parseExpression();
    if (this.#matchKeyword("GROUP")) {
      this.#expectKeyword("BY");
      groupBy.push(...this.#parseExpressionList());
    }
    if (this.#matchKeyword("HAVING")) having = this.#parseExpression();
    if (this.#matchKeyword("ORDER")) {
      this.#expectKeyword("BY");
      do {
        const expression = this.#parseExpression();
        const direction = this.#matchKeyword("ASC") ? "asc" : this.#matchKeyword("DESC") ? "desc" : undefined;
        const end = this.#previous().range;
        orderBy.push({ expression, ...(direction === undefined ? {} : { direction }), range: mergeRanges(expression.range, end) });
      } while (this.#matchPunctuation(","));
    }
    if (this.#matchKeyword("LIMIT")) limit = this.#parseExpression();
    if (this.#matchKeyword("OFFSET")) offset = this.#parseExpression();

    this.#matchPunctuation(";");
    const end = this.#previous().kind === "eof" ? columns.at(-1)?.range ?? start : this.#previous().range;
    this.#expect("eof", "end of query");
    return {
      kind: "select",
      distinct,
      columns,
      ...(from === undefined ? {} : { from }),
      joins,
      ...(where === undefined ? {} : { where }),
      groupBy,
      ...(having === undefined ? {} : { having }),
      orderBy,
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
      range: mergeRanges(start, end),
    };
  }

  #parseSelectList(): readonly SelectItem[] {
    const items: SelectItem[] = [];
    do {
      const expression = this.#parseExpression();
      let alias: Identifier | undefined;
      if (this.#matchKeyword("AS")) alias = this.#parseIdentifier();
      else if (this.#current().kind === "identifier" || this.#current().kind === "quoted-identifier") alias = this.#parseIdentifier();
      items.push({ expression, ...(alias === undefined ? {} : { alias }), range: mergeRanges(expression.range, alias?.range ?? expression.range) });
    } while (this.#matchPunctuation(","));
    return items;
  }

  #parseTableReference(): TableReference {
    const first = this.#parseIdentifier();
    let schema: Identifier | undefined;
    let name = first;
    if (this.#matchPunctuation(".")) {
      schema = first;
      name = this.#parseIdentifier();
    }
    let alias: Identifier | undefined;
    if (this.#matchKeyword("AS")) alias = this.#parseIdentifier();
    else if (this.#current().kind === "identifier" || this.#current().kind === "quoted-identifier") alias = this.#parseIdentifier();
    return {
      name,
      ...(schema === undefined ? {} : { schema }),
      ...(alias === undefined ? {} : { alias }),
      range: mergeRanges(first.range, alias?.range ?? name.range),
    };
  }

  #isJoinStart(): boolean {
    return ["JOIN", "INNER", "LEFT", "RIGHT", "FULL"].includes(this.#current().value);
  }

  #parseJoin(): JoinClause {
    const start = this.#current().range;
    let kind: JoinKind = "inner";
    if (this.#matchKeyword("INNER")) kind = "inner";
    else if (this.#matchKeyword("LEFT")) kind = "left";
    else if (this.#matchKeyword("RIGHT")) kind = "right";
    else if (this.#matchKeyword("FULL")) kind = "full";
    this.#matchKeyword("OUTER");
    this.#expectKeyword("JOIN");
    const table = this.#parseTableReference();
    this.#expectKeyword("ON");
    const on = this.#parseExpression();
    return { kind, table, on, range: mergeRanges(start, on.range) };
  }

  #parseExpressionList(): readonly Expression[] {
    const expressions: Expression[] = [];
    do expressions.push(this.#parseExpression()); while (this.#matchPunctuation(","));
    return expressions;
  }

  #parseExpression(minimum = 0): Expression {
    let left = this.#parseUnary();
    while (true) {
      if (this.#matchOperator("::")) {
        const databaseType = this.#parseIdentifier();
        left = { kind: "cast", expression: left, databaseType, syntax: "postgres", range: mergeRanges(left.range, databaseType.range) };
        continue;
      }
      const operator = this.#current().value.toUpperCase();
      const strength = precedence.get(operator);
      if (strength === undefined || strength < minimum) break;
      this.#advance();
      let completeOperator = operator;
      if (operator === "IS" && this.#matchKeyword("NOT")) completeOperator = "IS NOT";
      const right = this.#parseExpression(strength + 1);
      left = { kind: "binary", left, operator: completeOperator, right, range: mergeRanges(left.range, right.range) };
    }
    return left;
  }

  #parseUnary(): Expression {
    const token = this.#current();
    if (this.#matchKeyword("NOT") || this.#matchOperator("+") || this.#matchOperator("-")) {
      const expression = this.#parseUnary();
      return { kind: "unary", operator: token.value.toUpperCase(), expression, range: mergeRanges(token.range, expression.range) };
    }
    return this.#parsePrimary();
  }

  #parsePrimary(): Expression {
    const token = this.#current();
    if (this.#matchPunctuation("(")) {
      const expression = this.#parseExpression();
      this.#expectPunctuation(")");
      return expression;
    }
    if (this.#matchKeyword("CAST")) return this.#parseCast(token.range);
    if (this.#matchKeyword("CASE")) return this.#parseCase(token.range);
    if (this.#matchKeyword("NULL")) return { kind: "literal", value: null, range: token.range };
    if (this.#matchKeyword("TRUE")) return { kind: "literal", value: true, range: token.range };
    if (this.#matchKeyword("FALSE")) return { kind: "literal", value: false, range: token.range };
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
      if (this.#matchPunctuation("(")) {
        const args: Expression[] = [];
        if (!this.#matchPunctuation(")")) {
          do args.push(this.#parseExpression()); while (this.#matchPunctuation(","));
          const close = this.#expectPunctuation(")");
          return { kind: "call", name: first, arguments: args, range: mergeRanges(first.range, close.range) };
        }
        return { kind: "call", name: first, arguments: args, range: mergeRanges(first.range, this.#previous().range) };
      }
      if (this.#matchPunctuation(".")) {
        if (this.#matchOperator("*")) return { kind: "star", relation: first, range: mergeRanges(first.range, this.#previous().range) };
        const column = this.#parseIdentifier();
        return { kind: "column", relation: first, column, range: mergeRanges(first.range, column.range) };
      }
      return { kind: "column", column: first, range: first.range };
    }
    throw this.#error(`Expected expression, found ${token.text || "end of query"}`, token.range);
  }

  #parseCast(start: SourceRange): Expression {
    this.#expectPunctuation("(");
    const expression = this.#parseExpression();
    this.#expectKeyword("AS");
    const databaseType = this.#parseIdentifier();
    const close = this.#expectPunctuation(")");
    return { kind: "cast", expression, databaseType, syntax: "cast", range: mergeRanges(start, close.range) };
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
    let elseExpression: Expression | undefined;
    if (this.#matchKeyword("ELSE")) elseExpression = this.#parseExpression();
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

  #current(): Token {
    return this.#tokens[this.#index] ?? this.#tokens[this.#tokens.length - 1]!;
  }

  #previous(): Token {
    return this.#tokens[Math.max(0, this.#index - 1)]!;
  }

  #advance(): Token {
    const token = this.#current();
    if (token.kind !== "eof") this.#index += 1;
    return token;
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
    if (!this.#matchKeyword(keyword)) throw this.#error(`Expected ${keyword}, found ${token.text || "end of query"}`, token.range);
    return token;
  }

  #expectPunctuation(value: string): Token {
    const token = this.#current();
    if (!this.#matchPunctuation(value)) throw this.#error(`Expected ${value}, found ${token.text || "end of query"}`, token.range);
    return token;
  }

  #expect(kind: Token["kind"], label: string): Token {
    const token = this.#current();
    if (token.kind !== kind) throw this.#error(`Expected ${label}, found ${token.text || "end of query"}`, token.range);
    this.#advance();
    return token;
  }

  #error(message: string, range: SourceRange): SqlParseError {
    return new SqlParseError(message, range);
  }
}

export function parseSelect(source: string): SelectStatement {
  try {
    return new Parser(source).parseSelect();
  } catch (error) {
    if (error instanceof SqlTokenizeError) throw new SqlParseError(error.message, error.range);
    throw error;
  }
}
