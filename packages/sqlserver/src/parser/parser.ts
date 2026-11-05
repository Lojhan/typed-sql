import type { SourceRange } from "@typed-sql/core";
import { requireSqlServerNativeType } from "../native-types.js";
import { type TokenizeOptions, tokenize } from "./tokenizer.js";
import {
  type Assignment,
  type Cte,
  type Delete,
  type Expression,
  type FrameBoundary,
  type Insert,
  type Join,
  type Name,
  type Order,
  type Output,
  type Projection,
  type Select,
  type Source,
  SqlServerParseError,
  type Statement,
  type Token,
  type Top,
  type Update,
  type Window,
} from "./types.js";

const endProjection = new Set([
  "FROM",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "OFFSET",
  "FETCH",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "FOR",
  "OPTION",
  "INTO",
  "OUTPUT",
  "VALUES",
  "SET",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "OUTER",
  "ON",
  "WITH",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "AS",
  "ASC",
  "DESC",
]);
const precedence: Readonly<Record<string, number>> = {
  OR: 1,
  AND: 2,
  "=": 3,
  "<>": 3,
  "!=": 3,
  "<": 3,
  ">": 3,
  "<=": 3,
  ">=": 3,
  "!<": 3,
  "!>": 3,
  LIKE: 3,
  "+": 4,
  "-": 4,
  "&": 4,
  "|": 4,
  "^": 4,
  "*": 5,
  "/": 5,
  "%": 5,
};
function span(first: SourceRange, last: SourceRange): SourceRange {
  return { start: first.start, end: last.end, line: first.line, column: first.column };
}
class Parser {
  #index = 0;
  #depth = 0;
  constructor(readonly tokens: readonly Token[]) {}
  get token(): Token {
    return this.tokens[this.#index]!;
  }
  get previous(): Token {
    return this.tokens[Math.max(0, this.#index - 1)]!;
  }
  get upper(): string {
    return this.token.value.toUpperCase();
  }
  is(value: string): boolean {
    return this.upper === value;
  }
  next(): Token {
    const value = this.token;
    if (value.kind !== "eof") this.#index++;
    return value;
  }
  take(value: string): boolean {
    if (!this.is(value)) return false;
    this.next();
    return true;
  }
  need(value: string): Token {
    if (!this.is(value)) this.fail(`Expected ${value}`);
    return this.next();
  }
  fail(message: string, range = this.token.range): never {
    throw new SqlServerParseError(message, range);
  }
  identifier(): Token {
    if (this.token.kind !== "word" && this.token.kind !== "identifier") this.fail("Expected SQL identifier");
    return this.next();
  }
  name(): Name {
    const first = this.identifier();
    const parts = [first.value];
    while (this.take(".")) {
      if (this.is("*")) {
        this.#index--;
        break;
      }
      parts.push(this.identifier().value);
      if (parts.length > 4) this.fail("SQL Server names have at most four parts", first.range);
    }
    return { parts, range: span(first.range, this.previous.range) };
  }
  bounded<T>(fn: () => T): T {
    if (++this.#depth > 256) this.fail("SQL syntax nesting exceeds parser limit");
    try {
      return fn();
    } finally {
      this.#depth--;
    }
  }
  list<T>(fn: () => T): T[] {
    const items = [fn()];
    while (this.take(",")) {
      if (items.length >= 10000) this.fail("SQL list exceeds parser limit");
      items.push(fn());
    }
    return items;
  }
  names(): string[] {
    this.need("(");
    const values = this.list(() => this.identifier().value);
    this.need(")");
    return values;
  }
  parse(): Statement {
    this.take(";");
    const result = this.statement();
    this.take(";");
    if (this.token.kind !== "eof")
      this.fail("Only one complete SELECT, INSERT, UPDATE or DELETE statement is supported");
    return result;
  }
  statement(): Statement {
    return this.bounded(() => {
      const withClauses = this.ctes();
      if (this.is("SELECT")) return this.select(withClauses);
      if (this.is("INSERT")) return this.insert(withClauses);
      if (this.is("UPDATE")) return this.update(withClauses);
      if (this.is("DELETE")) return this.delete(withClauses);
      this.fail("Unsupported T-SQL statement; expected SELECT, INSERT, UPDATE or DELETE");
    });
  }
  ctes(): Cte[] {
    if (!this.take("WITH")) return [];
    return this.list(() => {
      const first = this.identifier();
      const columns = this.is("(") ? this.names() : [];
      this.need("AS");
      this.need("(");
      const query = this.selectOrWith();
      this.need(")");
      return { name: first.value, columns, query, range: span(first.range, this.previous.range) };
    });
  }
  selectOrWith(): Select {
    return this.bounded(() => {
      const withClauses = this.ctes();
      return this.select(withClauses);
    });
  }
  top(): Top | undefined {
    if (!this.take("TOP")) return undefined;
    const start = this.previous.range;
    let count: Expression;
    if (this.take("(")) {
      count = this.expression();
      this.need(")");
    } else {
      if (this.token.kind !== "number") this.fail("TOP requires a numeric literal or parenthesized expression");
      count = this.primary();
    }
    const percent = this.take("PERCENT");
    let ties = false;
    if (this.take("WITH")) {
      this.need("TIES");
      ties = true;
    }
    return { count, percent, ties, range: span(start, this.previous.range) };
  }
  select(withClauses: readonly Cte[] = []): Select {
    const start = this.need("SELECT").range;
    const distinct = this.take("DISTINCT");
    if (!distinct) this.take("ALL");
    const top = this.top();
    const projections = this.projections();
    if (this.is("INTO")) this.fail("SELECT INTO creates a relation and is not a row-only query");
    let from: Source | undefined;
    let joins: Join[] = [];
    if (this.take("FROM")) {
      from = this.source();
      joins = this.joins();
    }
    const where = this.take("WHERE") ? this.expression() : undefined;
    const group: Expression[] = [];
    if (this.take("GROUP")) {
      this.need("BY");
      group.push(...this.list(() => this.expression()));
    }
    const having = this.take("HAVING") ? this.expression() : undefined;
    const compounds: Select["compounds"][number][] = [];
    while (["UNION", "EXCEPT", "INTERSECT"].includes(this.upper)) {
      const operator = this.next().value.toLowerCase() as "union" | "except" | "intersect";
      const all = this.take("ALL");
      if (!all) this.take("DISTINCT");
      if (all && operator !== "union") this.fail("T-SQL supports ALL only for UNION");
      let query: Select;
      if (this.take("(")) {
        query = this.selectOrWith();
        this.need(")");
      } else query = this.selectBody();
      compounds.push({ operator, all, query });
    }
    let order: Order[] = [];
    if (this.take("ORDER")) {
      this.need("BY");
      order = this.orders();
    }
    const offset = this.take("OFFSET") ? this.expression() : undefined;
    if (offset) {
      if (!order.length) this.fail("OFFSET requires ORDER BY", offset.range);
      if (!this.take("ROWS")) this.need("ROW");
    }
    let fetch: Expression | undefined;
    if (this.take("FETCH")) {
      if (!offset) this.fail("FETCH requires OFFSET");
      if (!this.take("NEXT")) this.need("FIRST");
      fetch = this.expression();
      if (!this.take("ROWS")) this.need("ROW");
      this.need("ONLY");
    }
    if (top && (offset || fetch)) this.fail("TOP cannot be combined with OFFSET/FETCH", top.range);
    if (top?.ties && !order.length) this.fail("TOP WITH TIES requires ORDER BY", top.range);
    let forJson: Select["forJson"];
    let includeNulls = false;
    if (this.take("FOR")) {
      this.need("JSON");
      if (!this.is("PATH") && !this.is("AUTO")) this.fail("FOR JSON requires PATH or AUTO");
      forJson = this.next().value.toLowerCase() as "path" | "auto";
      if (this.take(",")) {
        this.need("INCLUDE_NULL_VALUES");
        includeNulls = true;
      }
    }
    if (this.is("OPTION")) this.fail("Query hints require explicit semantic support");
    return {
      kind: "select",
      with: withClauses,
      distinct,
      ...(top ? { top } : {}),
      projections,
      ...(from ? { from } : {}),
      joins,
      ...(where ? { where } : {}),
      group,
      ...(having ? { having } : {}),
      order,
      ...(offset ? { offset } : {}),
      ...(fetch ? { fetch } : {}),
      compounds,
      ...(forJson ? { forJson, includeNulls } : {}),
      range: span(start, this.previous.range),
    };
  }
  /** Parse one set-operation operand without consuming its siblings/final ORDER BY. */
  selectBody(): Select {
    const first = this.#index;
    // A bounded token sub-parser is unnecessary: operand nesting uses the same grammar and stop set.
    const start = this.need("SELECT").range,
      distinct = this.take("DISTINCT");
    if (!distinct) this.take("ALL");
    const top = this.top();
    const projections = this.projections();
    let from: Source | undefined;
    let joins: Join[] = [];
    if (this.take("FROM")) {
      from = this.source();
      joins = this.joins();
    }
    const where = this.take("WHERE") ? this.expression() : undefined;
    const group: Expression[] = [];
    if (this.take("GROUP")) {
      this.need("BY");
      group.push(...this.list(() => this.expression()));
    }
    const having = this.take("HAVING") ? this.expression() : undefined;
    if (this.#index <= first) this.fail("Invalid set operand");
    return {
      kind: "select",
      with: [],
      distinct,
      ...(top ? { top } : {}),
      projections,
      ...(from ? { from } : {}),
      joins,
      ...(where ? { where } : {}),
      group,
      ...(having ? { having } : {}),
      order: [],
      compounds: [],
      range: span(start, this.previous.range),
    };
  }
  projections(): Projection[] {
    return this.list(() => {
      const start = this.token.range;
      let alias: string | undefined;
      let expression: Expression;
      if (
        (this.token.kind === "word" || this.token.kind === "identifier" || this.token.kind === "string") &&
        this.tokens[this.#index + 1]?.value === "="
      ) {
        alias = this.next().value;
        this.need("=");
        expression = this.expression();
      } else {
        expression = this.expression();
        if (this.take("AS")) {
          if (this.token.kind === "string") alias = this.next().value;
          else alias = this.identifier().value;
        } else if ((this.token.kind === "identifier" || this.token.kind === "word") && !endProjection.has(this.upper))
          alias = this.next().value;
      }
      return { expression, ...(alias === undefined ? {} : { alias }), range: span(start, this.previous.range) };
    });
  }
  alias(): string | undefined {
    if (this.take("AS")) return this.identifier().value;
    if (
      (this.token.kind === "identifier" || this.token.kind === "word") &&
      !endProjection.has(this.upper) &&
      !["PIVOT", "UNPIVOT", "TABLESAMPLE"].includes(this.upper)
    )
      return this.next().value;
    return undefined;
  }
  source(): Source {
    const start = this.token.range;
    if (this.take("(")) {
      const query = this.selectOrWith();
      this.need(")");
      const alias = this.alias();
      if (!alias) this.fail("Derived table requires an alias");
      const columns = this.is("(") ? this.names() : [];
      return { kind: "derived", query, alias, columns, range: span(start, this.previous.range) };
    }
    const name = this.name();
    if (this.is("(")) {
      const call = this.call(name);
      let shape: Extract<Source, { kind: "function" }>["shape"];
      if (this.take("WITH")) {
        this.need("(");
        shape = this.list(() => {
          const field = this.identifier().value;
          const databaseType = this.nativeType();
          const path = this.token.kind === "string" ? this.next().value : undefined;
          let json = false;
          if (this.take("AS")) {
            this.need("JSON");
            json = true;
          }
          return { name: field, databaseType, ...(path === undefined ? {} : { path }), ...(json ? { json } : {}) };
        });
        this.need(")");
      }
      const alias = this.alias();
      const columns = this.is("(") ? this.names() : [];
      return {
        kind: "function",
        call,
        ...(alias ? { alias } : {}),
        columns,
        ...(shape ? { shape } : {}),
        range: span(start, this.previous.range),
      };
    }
    let systemTime: Expression | undefined;
    if (this.take("FOR")) {
      this.need("SYSTEM_TIME");
      this.need("AS");
      this.need("OF");
      systemTime = this.expression();
    }
    const alias = this.alias();
    const hints: string[] = [];
    if (this.take("WITH")) {
      this.need("(");
      do {
        const hint = this.identifier().value.toUpperCase();
        if (
          ![
            "NOLOCK",
            "READUNCOMMITTED",
            "UPDLOCK",
            "HOLDLOCK",
            "ROWLOCK",
            "TABLOCK",
            "TABLOCKX",
            "READPAST",
            "NOWAIT",
            "READCOMMITTED",
            "SERIALIZABLE",
          ].includes(hint)
        )
          this.fail("Unsupported table hint");
        hints.push(hint);
      } while (this.take(","));
      this.need(")");
    }
    return {
      kind: "table",
      name,
      ...(alias ? { alias } : {}),
      hints,
      ...(systemTime ? { systemTime } : {}),
      range: span(start, this.previous.range),
    };
  }
  joins(): Join[] {
    const items: Join[] = [];
    for (;;) {
      const start = this.token.range;
      let kind: Join["kind"];
      if (this.take(",")) kind = "cross";
      else if (this.take("JOIN")) kind = "inner";
      else if (this.take("INNER")) {
        this.need("JOIN");
        kind = "inner";
      } else if (this.take("LEFT")) {
        this.take("OUTER");
        this.need("JOIN");
        kind = "left";
      } else if (this.take("RIGHT")) {
        this.take("OUTER");
        this.need("JOIN");
        kind = "right";
      } else if (this.take("FULL")) {
        this.take("OUTER");
        this.need("JOIN");
        kind = "full";
      } else if (this.take("CROSS")) {
        if (this.take("APPLY")) kind = "cross-apply";
        else {
          this.need("JOIN");
          kind = "cross";
        }
      } else if (this.take("OUTER")) {
        this.need("APPLY");
        kind = "outer-apply";
      } else break;
      const source = this.source();
      let on: Expression | undefined;
      if (["inner", "left", "right", "full"].includes(kind)) {
        this.need("ON");
        on = this.expression();
      }
      items.push({ kind, source, ...(on ? { on } : {}), range: span(start, this.previous.range) });
      if (items.length > 256) this.fail("Join count exceeds limit");
    }
    return items;
  }
  orders(): Order[] {
    return this.list(() => {
      const expression = this.expression();
      const direction = this.take("DESC") ? "desc" : "asc";
      if (direction === "asc") this.take("ASC");
      return { expression, direction, range: span(expression.range, this.previous.range) };
    });
  }
  output(): Output | undefined {
    if (!this.take("OUTPUT")) return undefined;
    const start = this.previous.range;
    const projections = this.projections();
    let into: Name | undefined;
    let columns: string[] = [];
    if (this.take("INTO")) {
      into = this.name();
      columns = this.is("(") ? this.names() : [];
    }
    return { projections, ...(into ? { into } : {}), columns, range: span(start, this.previous.range) };
  }
  insert(withClauses: readonly Cte[]): Insert {
    const start = this.need("INSERT").range;
    this.take("INTO");
    const target = this.name();
    const columns = this.is("(") ? this.names() : [];
    const output = this.output();
    let values: Expression[][] = [];
    let query: Select | undefined;
    let defaultValues = false;
    if (this.take("DEFAULT")) {
      this.need("VALUES");
      defaultValues = true;
    } else if (this.take("VALUES")) {
      values = this.list(() => {
        this.need("(");
        const row = this.list(() => this.expression());
        this.need(")");
        return row;
      });
    } else query = this.selectOrWith();
    return {
      kind: "insert",
      with: withClauses,
      target,
      columns,
      values,
      ...(query ? { query } : {}),
      defaultValues,
      ...(output ? { output } : {}),
      range: span(start, this.previous.range),
    };
  }
  update(withClauses: readonly Cte[]): Update {
    const start = this.need("UPDATE").range;
    const top = this.top();
    if (top?.ties || top?.percent) this.fail("UPDATE TOP only supports a row count", top.range);
    const target = this.name();
    this.need("SET");
    const assignments = this.list(() => {
      const column = this.name();
      this.need("=");
      const value = this.expression();
      return { column, value, range: span(column.range, value.range) } satisfies Assignment;
    });
    const output = this.output();
    let from: Source | undefined;
    let joins: Join[] = [];
    if (this.take("FROM")) {
      from = this.source();
      joins = this.joins();
    }
    const where = this.take("WHERE") ? this.expression() : undefined;
    return {
      kind: "update",
      with: withClauses,
      target,
      ...(top ? { top } : {}),
      assignments,
      ...(output ? { output } : {}),
      ...(from ? { from } : {}),
      joins,
      ...(where ? { where } : {}),
      range: span(start, this.previous.range),
    };
  }
  delete(withClauses: readonly Cte[]): Delete {
    const start = this.need("DELETE").range;
    const top = this.top();
    if (top?.ties || top?.percent) this.fail("DELETE TOP only supports a row count", top.range);
    this.take("FROM");
    const target = this.name();
    const output = this.output();
    let from: Source | undefined;
    let joins: Join[] = [];
    if (this.take("FROM")) {
      from = this.source();
      joins = this.joins();
    }
    const where = this.take("WHERE") ? this.expression() : undefined;
    return {
      kind: "delete",
      with: withClauses,
      target,
      ...(top ? { top } : {}),
      ...(output ? { output } : {}),
      ...(from ? { from } : {}),
      joins,
      ...(where ? { where } : {}),
      range: span(start, this.previous.range),
    };
  }
  expression(minimum = 0): Expression {
    return this.bounded(() => {
      let left = this.primary();
      for (;;) {
        const start = left.range;
        let not = false;
        if (
          this.is("NOT") &&
          ["IN", "LIKE", "BETWEEN"].includes(this.tokens[this.#index + 1]?.value.toUpperCase() ?? "")
        ) {
          if (minimum > 3) break;
          this.next();
          not = true;
        }
        if (this.is("IS") && minimum <= 3) {
          this.next();
          const negate = this.take("NOT");
          this.need("NULL");
          left = { kind: "isnull", argument: left, not: negate, range: span(start, this.previous.range) };
          continue;
        }
        if (this.is("IN") && minimum <= 3) {
          this.next();
          this.need("(");
          const values =
            this.is("SELECT") || this.is("WITH") ? this.selectOrWith() : this.list(() => this.expression());
          this.need(")");
          left = { kind: "in", argument: left, values, not, range: span(start, this.previous.range) };
          continue;
        }
        if (this.is("BETWEEN") && minimum <= 3) {
          this.next();
          const lower = this.expression(4);
          this.need("AND");
          const upper = this.expression(4);
          left = { kind: "between", argument: left, lower, upper, not, range: span(start, this.previous.range) };
          continue;
        }
        const level = precedence[this.upper];
        if (level === undefined || level < minimum) {
          if (not) this.fail("Expected IN, LIKE or BETWEEN after NOT");
          break;
        }
        const operator = this.next().value.toUpperCase();
        const right = this.expression(level + 1);
        left = {
          kind: "binary",
          operator: not ? `NOT ${operator}` : operator,
          left,
          right,
          range: span(start, right.range),
        };
      }
      return left;
    });
  }
  primary(): Expression {
    const token = this.next(),
      start = token.range,
      upper = token.value.toUpperCase();
    if (token.kind === "string")
      return {
        kind: "literal",
        literal: "string",
        value: token.value,
        unicode: /^[Nn]/u.test(token.text),
        range: start,
      };
    if (token.kind === "number") return { kind: "literal", literal: "number", value: token.value, range: start };
    if (token.kind === "binary") return { kind: "literal", literal: "binary", value: token.value, range: start };
    if (token.kind === "parameter") {
      const name = /^@__typed_sql_\d+$/u.test(token.text) || token.text === "?" ? undefined : token.text.slice(1);
      return { kind: "parameter", index: Number(token.value), ...(name ? { name } : {}), range: start };
    }
    if (token.kind === "system") return { kind: "system", name: upper, range: start };
    if (upper === "NULL") return { kind: "literal", literal: "null", value: null, range: start };
    if (upper === "DEFAULT") return { kind: "default", range: start };
    if (upper === "NOT" || ["+", "-", "~"].includes(upper)) {
      const argument = this.expression(upper === "NOT" ? 3 : 6);
      return { kind: "unary", operator: upper, argument, range: span(start, argument.range) };
    }
    if (upper === "EXISTS") {
      this.need("(");
      const query = this.selectOrWith();
      this.need(")");
      return { kind: "exists", query, not: false, range: span(start, this.previous.range) };
    }
    if (upper === "CASE") {
      const operand = this.is("WHEN") ? undefined : this.expression();
      const arms: { when: Expression; then: Expression }[] = [];
      while (this.take("WHEN")) {
        const when = this.expression();
        this.need("THEN");
        const then = this.expression();
        arms.push({ when, then });
        if (arms.length > 256) this.fail("CASE arms exceed limit");
      }
      if (!arms.length) this.fail("CASE requires WHEN");
      const otherwise = this.take("ELSE") ? this.expression() : undefined;
      this.need("END");
      return {
        kind: "case",
        ...(operand ? { operand } : {}),
        arms,
        ...(otherwise ? { otherwise } : {}),
        range: span(start, this.previous.range),
      };
    }
    if (["CAST", "TRY_CAST", "CONVERT", "TRY_CONVERT"].includes(upper) && this.take("(")) {
      let argument: Expression, databaseType: string, style: Expression | undefined;
      if (upper.endsWith("CONVERT")) {
        databaseType = this.nativeType();
        this.need(",");
        argument = this.expression();
        if (this.take(",")) style = this.expression();
      } else {
        argument = this.expression();
        this.need("AS");
        databaseType = this.nativeType();
      }
      this.need(")");
      return {
        kind: "cast",
        argument,
        databaseType,
        try: upper.startsWith("TRY_"),
        ...(style ? { style } : {}),
        range: span(start, this.previous.range),
      };
    }
    if (token.value === "(") {
      if (this.is("SELECT") || this.is("WITH")) {
        const query = this.selectOrWith();
        this.need(")");
        return { kind: "subquery", query, range: span(start, this.previous.range) };
      }
      const value = this.expression();
      this.need(")");
      return { ...value, range: span(start, this.previous.range) };
    }
    if (token.value === "*") return { kind: "star", range: start };
    if (token.kind !== "word" && token.kind !== "identifier") this.fail("Expected scalar SQL expression", start);
    const parts = [token.value];
    while (this.take(".")) {
      if (this.take("*"))
        return {
          kind: "star",
          qualifier: { parts, range: span(start, this.previous.range) },
          range: span(start, this.previous.range),
        };
      parts.push(this.identifier().value);
      if (parts.length > 4) this.fail("SQL names have at most four parts", start);
    }
    const name = { parts, range: span(start, this.previous.range) };
    if (this.is("(")) return this.call(name);
    if (
      ["CURRENT_TIMESTAMP", "CURRENT_USER", "SESSION_USER", "SYSTEM_USER", "USER"].includes(upper) &&
      parts.length === 1
    )
      return { kind: "call", name, arguments: [], distinct: false, range: name.range };
    return { kind: "column", name, range: name.range };
  }
  call(name: Name): Expression & { kind: "call" } {
    this.need("(");
    const distinct = this.take("DISTINCT");
    if (!distinct) this.take("ALL");
    const args = this.take(")") ? [] : this.list(() => this.expression());
    if (this.previous.value !== ")" || args.length) this.need(")");
    let withinGroup: Order[] | undefined;
    if (this.take("WITHIN")) {
      this.need("GROUP");
      this.need("(");
      this.need("ORDER");
      this.need("BY");
      withinGroup = this.orders();
      this.need(")");
    }
    const over = this.take("OVER") ? this.window() : undefined;
    return {
      kind: "call",
      name,
      arguments: args,
      distinct,
      ...(over ? { over } : {}),
      ...(withinGroup ? { withinGroup } : {}),
      range: span(name.range, this.previous.range),
    };
  }
  window(): Window {
    const start = this.need("(").range;
    let partition: Expression[] = [];
    let order: Order[] = [];
    if (this.take("PARTITION")) {
      this.need("BY");
      partition = this.list(() => this.expression());
    }
    if (this.take("ORDER")) {
      this.need("BY");
      order = this.orders();
    }
    let frame: Window["frame"];
    if (this.is("ROWS") || this.is("RANGE")) {
      const kind = this.next().value.toLowerCase() as "rows" | "range";
      const between = this.take("BETWEEN");
      const first = this.frameBoundary();
      if (between) this.need("AND");
      const end = between ? this.frameBoundary() : undefined;
      frame = { kind, start: first, ...(end ? { end } : {}) };
    }
    this.need(")");
    return { partition, order, ...(frame ? { frame } : {}), range: span(start, this.previous.range) };
  }
  frameBoundary(): FrameBoundary {
    const start = this.token.range;
    if (this.take("CURRENT")) {
      this.need("ROW");
      return { kind: "current", range: span(start, this.previous.range) };
    }
    const unbounded = this.take("UNBOUNDED");
    const offset = unbounded ? undefined : this.expression(6);
    let kind: FrameBoundary["kind"];
    if (this.take("PRECEDING")) kind = "preceding";
    else {
      this.need("FOLLOWING");
      kind = "following";
    }
    return {
      kind,
      ...(unbounded ? { unbounded } : {}),
      ...(offset ? { offset } : {}),
      range: span(start, this.previous.range),
    };
  }
  nativeType(): string {
    const start = this.token.range;
    const name = this.identifier().value;
    let source = name;
    if (this.take("(")) {
      const first = this.next();
      if (first.kind !== "number" && first.value.toUpperCase() !== "MAX")
        this.fail("Expected type length, precision or MAX", first.range);
      source += `(${first.value}`;
      if (this.take(",")) {
        const scale = this.next();
        if (scale.kind !== "number") this.fail("Expected type scale", scale.range);
        source += `,${scale.value}`;
      }
      this.need(")");
      source += ")";
    }
    try {
      return requireSqlServerNativeType(source).text;
    } catch {
      this.fail("Unsupported or invalid native SQL Server type", span(start, this.previous.range));
    }
  }
}
export function parseStatement(source: string, options: TokenizeOptions = {}): Statement {
  return new Parser(tokenize(source, options)).parse();
}
