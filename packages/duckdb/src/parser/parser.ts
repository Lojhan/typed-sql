import type { SourceRange } from "@typed-sql/core";
import { formatDuckDBType, parseDuckDBType } from "../native-types.js";
import { DuckDBParseError, tokenize } from "./tokenizer.js";
import type { CommonTable, Expression, Projection, Relation, Statement, Token } from "./types.js";

const clauses = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP",
  "HAVING",
  "WINDOW",
  "QUALIFY",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "FETCH",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "RETURNING",
  "SET",
  "VALUES",
  "ON",
  "USING",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "SEMI",
  "ANTI",
  "ASOF",
  "POSITIONAL",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
]);
const joinWords = new Set([
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "SEMI",
  "ANTI",
  "ASOF",
  "POSITIONAL",
  "NATURAL",
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
  IS: 3,
  IN: 3,
  LIKE: 3,
  ILIKE: 3,
  BETWEEN: 3,
  "||": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "//": 6,
  "%": 6,
  "**": 7,
  "->": 1,
  "->>": 7,
};
export class DuckDBParser {
  private index = 0;
  private depth = 0;
  private anonymous = 0;
  private readonly named = new Map<string, number>();
  readonly tokens: readonly Token[];
  constructor(readonly source: string) {
    this.tokens = tokenize(source);
  }
  token(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }
  is(value: string, offset = 0): boolean {
    return (
      this.token(offset).kind !== "quoted" &&
      this.token(offset).kind !== "string" &&
      this.token(offset).value.toUpperCase() === value
    );
  }
  accept(value: string): boolean {
    if (!this.is(value)) return false;
    this.index++;
    return true;
  }
  take(): Token {
    const token = this.token();
    if (token.kind !== "eof") this.index++;
    return token;
  }
  expect(value: string): void {
    if (!this.accept(value))
      throw new DuckDBParseError(`Expected ${value}, found ${this.token().text || "end of SQL"}`, this.token().range);
  }
  identifier(): Token {
    const token = this.take();
    if (token.kind !== "word" && token.kind !== "quoted")
      throw new DuckDBParseError("Expected SQL identifier", token.range);
    return token;
  }
  range(start: SourceRange): SourceRange {
    return { ...start, end: this.tokens[Math.max(0, this.index - 1)]!.range.end };
  }
  qualified(): readonly string[] {
    const names = [this.identifier().value];
    while (this.is(".") && !this.is("*", 1)) {
      this.take();
      names.push(this.identifier().value);
    }
    return names;
  }
  list<T>(read: () => T, end?: string): T[] {
    const values: T[] = [];
    if (end && this.accept(end)) return values;
    do {
      values.push(read());
      if (!this.accept(",")) break;
      if (end && this.is(end)) break;
    } while (this.token().kind !== "eof");
    if (end) this.expect(end);
    return values;
  }
  expression(min = 0): Expression {
    if (++this.depth > 128) throw new DuckDBParseError("SQL expression depth limit", this.token().range, "TSQ002");
    try {
      let left = this.prefix();
      for (;;) {
        const start = left.range;
        if (this.accept("::")) {
          const type = this.nativeType();
          left = { kind: "cast", left, nativeType: type, range: this.range(start) };
          continue;
        }
        if (this.accept("[")) {
          const args: Expression[] = [];
          if (!this.is(":")) args.push(this.expression());
          if (this.accept(":")) {
            args.push(this.is("]") ? { kind: "literal", value: "NULL", range: this.token().range } : this.expression());
            if (this.accept(":")) args.push(this.expression());
          }
          this.expect("]");
          left = { kind: "index", left, args, range: this.range(start) };
          continue;
        }
        if (this.accept(".")) {
          const field = this.accept("*") ? "*" : this.identifier().value;
          left = { kind: field === "*" ? "star" : "name", names: [field], left, range: this.range(start) };
          continue;
        }
        if (this.accept("FILTER")) {
          this.expect("(");
          this.expect("WHERE");
          const filter = this.expression();
          this.expect(")");
          left = { ...left, filter, range: this.range(start) };
          continue;
        }
        if (this.accept("OVER")) {
          let context: readonly Expression[] = [],
            windowName: string | undefined;
          if (this.accept("(")) {
            const specification = this.windowSpec();
            context = specification.expressions;
            windowName = specification.base;
          } else windowName = this.identifier().value;
          left = {
            ...left,
            window: true,
            context: [...(left.context ?? []), ...context],
            ...(windowName ? { windowName } : {}),
            range: this.range(start),
          };
          continue;
        }
        let op = this.token().value.toUpperCase();
        const negate = op === "NOT" && ["IN", "LIKE", "ILIKE", "BETWEEN"].some((word) => this.is(word, 1));
        if (negate) op = this.token(1).value.toUpperCase();
        const power = precedence[op];
        if (power === undefined || power < min) break;
        this.take();
        if (negate) this.take();
        if (op === "IS") {
          const not = this.accept("NOT");
          if (this.accept("DISTINCT")) {
            this.expect("FROM");
            left = {
              kind: "binary",
              value: not ? "IS NOT DISTINCT FROM" : "IS DISTINCT FROM",
              left,
              right: this.expression(power + 1),
              range: this.range(start),
            };
          } else {
            const right = this.prefix();
            left = { kind: "binary", value: not ? "IS NOT" : "IS", left, right, range: this.range(start) };
          }
          continue;
        }
        if (op === "BETWEEN") {
          const low = this.expression(power + 1);
          this.expect("AND");
          const high = this.expression(power + 1);
          left = {
            kind: "call",
            names: [negate ? "NOT BETWEEN" : "BETWEEN"],
            args: [left, low, high],
            range: this.range(start),
          };
          continue;
        }
        if (op === "IN") {
          this.expect("(");
          let args: Expression[];
          if (this.is("SELECT") || this.is("WITH") || this.is("FROM")) {
            const query = this.statement();
            this.expect(")");
            args = [{ kind: "subquery", query, range: query.range }];
          } else args = this.list(() => this.expression(), ")");
          left = { kind: "call", names: [negate ? "NOT IN" : "IN"], args: [left, ...args], range: this.range(start) };
          continue;
        }
        const right = this.expression(power + (op === "**" ? 0 : 1));
        left = {
          kind: "binary",
          value: negate ? `NOT ${op}` : op,
          left,
          right,
          range: this.range(start),
        };
      }
      return left;
    } finally {
      this.depth--;
    }
  }
  prefix(): Expression {
    const token = this.take(),
      range = token.range,
      upper = token.value.toUpperCase();
    if (token.kind === "number" || token.kind === "string" || ["NULL", "TRUE", "FALSE"].includes(upper))
      return { kind: "literal", value: token.kind === "string" ? JSON.stringify(token.value) : upper, range };
    if (token.text === ":" && this.token().kind === "word" && this.token().range.start === token.range.end) {
      const name = this.take().value;
      let slot = this.named.get(name);
      if (slot === undefined) {
        slot = this.named.size + 1;
        this.named.set(name, slot);
      }
      return { kind: "parameter", value: String(slot), range: this.range(range) };
    }
    if (token.kind === "parameter") {
      let value: string;
      if (token.value === "?") value = String(++this.anonymous);
      else if (/^\$\d+$/u.test(token.value)) value = token.value.slice(1);
      else {
        const name = token.value.slice(1);
        let slot = this.named.get(name);
        if (slot === undefined) {
          slot = this.named.size + 1;
          this.named.set(name, slot);
        }
        value = String(slot);
      }
      if (!/^[1-9]\d*$/u.test(value) || Number(value) > 65535)
        throw new DuckDBParseError("Invalid DuckDB parameter slot", range);
      return { kind: "parameter", value, range };
    }
    if (["NOT", "+", "-", "~", "EXISTS"].includes(upper))
      return { kind: "unary", value: upper, left: this.expression(upper === "NOT" ? 3 : 8), range: this.range(range) };
    if (upper === "*") return { kind: "star", range };
    if (upper === "LAMBDA") {
      const names = this.list(() => this.identifier().value);
      this.expect(":");
      const right = this.expression();
      return { kind: "lambda", value: "lambda", names, right, range: this.range(range) };
    }
    if (upper === "MAP" && this.accept("{")) {
      const keys: Expression[] = [],
        values: Expression[] = [];
      if (!this.accept("}")) {
        do {
          keys.push(this.expression());
          this.expect(":");
          values.push(this.expression());
        } while (this.accept(",") && !this.is("}"));
        this.expect("}");
      }
      return {
        kind: "call",
        names: ["map"],
        args: [
          { kind: "list", args: keys, range: this.range(range) },
          { kind: "list", args: values, range: this.range(range) },
        ],
        range: this.range(range),
      };
    }

    if (upper === "(") {
      if (this.is("SELECT") || this.is("WITH") || this.is("FROM")) {
        const query = this.statement();
        this.expect(")");
        return { kind: "subquery", query, range: this.range(range) };
      }
      const args = this.list(() => this.expression(), ")");
      if (args.length === 1) return { ...args[0]!, range: this.range(range) };
      return { kind: "tuple", args, range: this.range(range) };
    }
    if (upper === "[") {
      if (this.accept("]")) return { kind: "list", args: [], range: this.range(range) };
      const first = this.expression();
      if (this.accept("FOR")) {
        const name = this.identifier().value;
        this.expect("IN");
        let source = this.expression();
        if (this.accept("IF")) {
          const right = this.expression();
          source = {
            kind: "call",
            names: ["list_filter"],
            args: [source, { kind: "lambda", value: "lambda", names: [name], right, range: this.range(range) }],
            range: this.range(range),
          };
        }
        this.expect("]");
        return {
          kind: "call",
          names: ["list_transform"],
          args: [source, { kind: "lambda", value: "lambda", names: [name], right: first, range: this.range(range) }],
          range: this.range(range),
        };
      }
      const args = [first];
      while (this.accept(",") && !this.is("]")) args.push(this.expression());
      this.expect("]");
      return { kind: "list", args, range: this.range(range) };
    }
    if (upper === "{") {
      const names: string[] = [],
        args: Expression[] = [];
      if (!this.accept("}")) {
        do {
          const field = this.take();
          if (!["word", "quoted", "string"].includes(field.kind))
            throw new DuckDBParseError("Expected struct field name", field.range);
          names.push(field.value);
          this.expect(":");
          args.push(this.expression());
        } while (this.accept(",") && !this.is("}"));
        this.expect("}");
      }
      return { kind: "struct", names, args, range: this.range(range) };
    }
    if (upper === "CASE") {
      const args: Expression[] = [];
      let base: Expression | undefined;
      if (!this.is("WHEN")) base = this.expression();
      while (this.accept("WHEN")) {
        const condition = this.expression();
        this.expect("THEN");
        const value = this.expression();
        args.push(
          base ? { kind: "binary", value: "=", left: base, right: condition, range: condition.range } : condition,
          value,
        );
      }
      if (this.accept("ELSE")) args.push(this.expression());
      this.expect("END");
      return { kind: "case", args, range: this.range(range) };
    }
    if (upper === "CAST" || upper === "TRY_CAST") {
      this.expect("(");
      const left = this.expression();
      this.expect("AS");
      const nativeType = this.nativeType();
      this.expect(")");
      return { kind: "cast", value: upper, left, nativeType, range: this.range(range) };
    }
    if (token.kind !== "word" && token.kind !== "quoted")
      throw new DuckDBParseError(`Expected SQL expression, found ${token.text}`, range);
    if (
      [
        "DATE",
        "TIME",
        "TIMESTAMP",
        "TIMESTAMPTZ",
        "TIMESTAMP_NS",
        "TIMESTAMP_MS",
        "TIMESTAMP_S",
        "TIMESTAMPTZ_NS",
        "INTERVAL",
      ].includes(upper) &&
      this.token().kind === "string"
    ) {
      const literal = this.take();
      return {
        kind: "cast",
        left: { kind: "literal", value: JSON.stringify(literal.value), range: literal.range },
        nativeType: upper,
        range: this.range(range),
      };
    }
    const names = [token.value];
    while (this.is(".") && ["word", "quoted"].includes(this.token(1).kind)) {
      this.take();
      names.push(this.take().value);
    }
    if (this.accept("(")) {
      const distinct = this.accept("DISTINCT"),
        args: Expression[] = [],
        argumentNames: (string | undefined)[] = [],
        context: Expression[] = [];
      if (!this.accept(")")) {
        do {
          let name: string | undefined;
          if (["word", "quoted"].includes(this.token().kind) && (this.is(":=", 1) || this.is("=>", 1))) {
            name = this.take().value;
            this.take();
          }
          argumentNames.push(name);
          args.push(this.expression());
          if (this.accept("ORDER")) {
            this.expect("BY");
            context.push(...this.list(() => this.ordered()));
          }
        } while (this.accept(",") && !this.is(")"));
        this.expect(")");
      }
      return { kind: "call", names, args, argumentNames, distinct, context, range: this.range(range) };
    }
    return { kind: "name", names, range: this.range(range) };
  }
  nativeType(): string {
    const start = this.index;
    this.identifier();
    if ((this.is("WITH") || this.is("WITHOUT")) && this.is("TIME", 1)) {
      this.take();
      this.take();
      this.expect("ZONE");
    } else if (this.is("PRECISION")) this.take();
    if (this.accept("(")) {
      let depth = 1;
      while (depth) {
        const token = this.take();
        if (token.kind === "eof") throw new DuckDBParseError("Unterminated type declaration", token.range);
        if (token.value === "(") depth++;
        else if (token.value === ")") depth--;
        if (depth > 32) throw new DuckDBParseError("Native type nesting limit", token.range, "TSQ002");
      }
    }
    while (this.accept("[")) {
      if (!this.accept("]")) {
        if (this.token().kind !== "number") throw new DuckDBParseError("Expected fixed array size", this.token().range);
        this.take();
        this.expect("]");
      }
    }
    const first = this.tokens[start]!,
      last = this.tokens[this.index - 1]!;
    const text = this.source.slice(first.range.start, last.range.end);
    try {
      return formatDuckDBType(parseDuckDBType(text));
    } catch (error) {
      throw new DuckDBParseError(error instanceof Error ? error.message : "Invalid DuckDB type", first.range);
    }
  }
  ordered(): Expression {
    const value = this.expression();
    this.accept("ASC") || this.accept("DESC");
    if (this.accept("NULLS")) {
      if (!this.accept("FIRST")) this.expect("LAST");
    }
    return value;
  }
  windowSpec(): { expressions: Expression[]; base?: string } {
    const expressions: Expression[] = [];
    let base: string | undefined;
    if (
      this.token().kind === "word" &&
      !this.is("PARTITION") &&
      !this.is("ORDER") &&
      !this.is("ROWS") &&
      !this.is("RANGE") &&
      !this.is("GROUPS")
    )
      base = this.identifier().value;
    if (this.accept("PARTITION")) {
      this.expect("BY");
      expressions.push(...this.list(() => this.expression()));
    }
    if (this.accept("ORDER")) {
      this.expect("BY");
      expressions.push(...this.list(() => this.ordered()));
    }
    if (this.accept("ROWS") || this.accept("RANGE") || this.accept("GROUPS")) {
      const bound = () => {
        if (this.accept("UNBOUNDED")) {
          if (!this.accept("PRECEDING")) this.expect("FOLLOWING");
        } else if (this.accept("CURRENT")) this.expect("ROW");
        else {
          expressions.push(this.expression());
          if (!this.accept("PRECEDING")) this.expect("FOLLOWING");
        }
      };
      if (this.accept("BETWEEN")) {
        bound();
        this.expect("AND");
        bound();
      } else bound();
      if (this.accept("EXCLUDE")) {
        if (this.accept("CURRENT")) this.expect("ROW");
        else if (!this.accept("GROUP") && !this.accept("TIES")) {
          this.expect("NO");
          this.expect("OTHERS");
        }
      }
    }
    this.expect(")");
    return { expressions, ...(base ? { base } : {}) };
  }
  projections(): Projection[] {
    return this.list(() => {
      let alias: string | undefined;
      let expression: Expression;
      if (["word", "quoted"].includes(this.token().kind) && this.is(":", 1)) {
        alias = this.take().value;
        this.take();
        expression = this.expression();
      } else expression = this.expression();
      let exclude: readonly string[] | undefined, replace: readonly Projection[] | undefined;
      if (expression.kind === "star") {
        if (this.accept("EXCLUDE")) {
          if (this.accept("(")) exclude = this.list(() => this.identifier().value, ")");
          else exclude = [this.identifier().value];
        }
        if (this.accept("REPLACE")) {
          this.expect("(");
          replace = this.projections();
          this.expect(")");
        }
      }
      if (this.accept("AS")) alias = this.identifier().value;
      else if (
        ["word", "quoted"].includes(this.token().kind) &&
        !clauses.has(this.token().value.toUpperCase()) &&
        !joinWords.has(this.token().value.toUpperCase())
      )
        alias = this.take().value;
      return {
        expression,
        ...(alias === undefined ? {} : { alias }),
        ...(exclude ? { exclude } : {}),
        ...(replace ? { replace } : {}),
      };
    });
  }
  relation(): Relation {
    const start = this.token().range,
      lateral = this.accept("LATERAL");
    let query: Statement | undefined, expression: Expression | undefined, name: readonly string[] | undefined;
    if (this.accept("(")) {
      query = this.statement();
      this.expect(")");
    } else {
      const candidate = this.expression(9);
      if (candidate.kind === "name" && !candidate.left) name = candidate.names;
      else expression = candidate;
    }
    const ordinality = this.accept("WITH");
    if (ordinality) this.expect("ORDINALITY");
    let alias: string | undefined, columns: readonly string[] | undefined;
    if (this.accept("AS")) alias = this.identifier().value;
    else if (
      ["word", "quoted"].includes(this.token().kind) &&
      !clauses.has(this.token().value.toUpperCase()) &&
      !joinWords.has(this.token().value.toUpperCase())
    )
      alias = this.take().value;
    if (alias && this.accept("(")) columns = this.list(() => this.identifier().value, ")");
    return {
      range: this.range(start),
      ...(lateral ? { lateral } : {}),
      ...(ordinality ? { ordinality } : {}),
      ...(name ? { name } : {}),
      ...(expression ? { expression } : {}),
      ...(query ? { query } : {}),
      ...(alias ? { alias } : {}),
      ...(columns ? { columns } : {}),
    };
  }
  relations(): Relation[] {
    const values = [this.relation()];
    for (;;) {
      if (this.accept(",")) {
        values.push({ ...this.relation(), join: "cross" });
        continue;
      }
      if (!joinWords.has(this.token().value.toUpperCase())) break;
      const natural = this.accept("NATURAL");
      let asof = this.accept("ASOF");
      let kind: NonNullable<Relation["join"]> = "inner";
      for (const word of ["INNER", "LEFT", "RIGHT", "FULL", "CROSS", "SEMI", "ANTI", "ASOF", "POSITIONAL"] as const) {
        if (this.accept(word)) {
          kind = word.toLowerCase() as NonNullable<Relation["join"]>;
          break;
        }
      }
      asof = this.accept("ASOF") || asof;
      if (asof) {
        if (kind !== "inner" && kind !== "left")
          throw new DuckDBParseError("ASOF supports INNER or LEFT JOIN", this.token().range, "TSQ201");
        kind = kind === "left" ? "asof-left" : "asof";
      }
      this.accept("OUTER");
      this.accept("JOIN") || kind === "positional" || this.expect("JOIN");
      const relation = this.relation();
      let condition: Expression | undefined, using: readonly string[] | undefined;
      if (this.accept("ON")) condition = this.expression();
      else if (this.accept("USING")) {
        this.expect("(");
        using = this.list(() => this.identifier().value, ")");
      } else if (!natural && !["cross", "positional"].includes(kind))
        throw new DuckDBParseError("JOIN requires ON or USING", this.token().range);
      values.push({
        ...relation,
        join: kind,
        ...(natural ? { natural } : {}),
        ...(condition ? { condition } : {}),
        ...(using ? { using } : {}),
      });
    }
    return values;
  }
  statement(): Statement {
    if (++this.depth > 128) throw new DuckDBParseError("SQL query nesting limit", this.token().range, "TSQ002");
    try {
      const start = this.token().range,
        ctes: CommonTable[] = [];
      if (this.accept("WITH")) {
        const recursive = this.accept("RECURSIVE");
        do {
          const name = this.identifier().value;
          const columns = this.accept("(") ? this.list(() => this.identifier().value, ")") : undefined;
          this.expect("AS");
          if (this.accept("NOT")) this.expect("MATERIALIZED");
          else this.accept("MATERIALIZED");
          this.expect("(");
          const query = this.statement();
          this.expect(")");
          ctes.push({ name, query, recursive, ...(columns ? { columns } : {}) });
        } while (this.accept(","));
      }
      let result: Statement;
      if (this.is("SELECT") || this.is("FROM")) result = this.select(start, ctes);
      else if (this.accept("INSERT")) {
        let conflict = false;
        if (this.accept("OR")) {
          if (!this.accept("IGNORE")) this.expect("REPLACE");
          conflict = true;
        }
        this.expect("INTO");
        const target = this.qualified(),
          columns = this.accept("(") ? this.list(() => this.identifier().value, ")") : undefined;
        let byName = false;
        if (this.accept("BY")) {
          this.expect("NAME");
          byName = true;
        }
        let values: Expression[][] | undefined, source: Statement | undefined;
        if (this.accept("VALUES"))
          values = this.list(() => {
            this.expect("(");
            return this.list(() => this.expression(), ")");
          });
        else if (this.accept("DEFAULT")) {
          this.expect("VALUES");
          values = [[]];
        } else source = this.statement();
        if (this.accept("ON")) {
          this.expect("CONFLICT");
          if (this.accept("(")) this.list(() => this.identifier().value, ")");
          this.expect("DO");
          if (!this.accept("NOTHING")) {
            this.expect("UPDATE");
            this.expect("SET");
            this.assignments();
            if (this.accept("WHERE")) this.expression();
          }
          conflict = true;
        }
        const returning = this.accept("RETURNING") ? this.projections() : undefined;
        result = {
          kind: "insert",
          range: this.range(start),
          ctes,
          projections: [],
          relations: [],
          target,
          ...(columns ? { columns } : {}),
          ...(values ? { values } : {}),
          ...(source ? { source } : {}),
          ...(returning ? { returning } : {}),
          ...(byName ? { byName } : {}),
          ...(conflict ? { conflict } : {}),
        };
      } else if (this.accept("UPDATE")) {
        const target = this.qualified();
        if (this.accept("AS")) this.identifier();
        this.expect("SET");
        const assignments = this.assignments(),
          relations = this.accept("FROM") ? this.relations() : [],
          where = this.accept("WHERE") ? this.expression() : undefined,
          returning = this.accept("RETURNING") ? this.projections() : undefined;
        result = {
          kind: "update",
          range: this.range(start),
          ctes,
          projections: [],
          relations,
          target,
          assignments,
          ...(where ? { where } : {}),
          ...(returning ? { returning } : {}),
        };
      } else if (this.accept("DELETE")) {
        this.expect("FROM");
        const target = this.qualified();
        if (this.accept("AS")) this.identifier();
        const relations = this.accept("USING") ? this.relations() : [],
          where = this.accept("WHERE") ? this.expression() : undefined,
          returning = this.accept("RETURNING") ? this.projections() : undefined;
        result = {
          kind: "delete",
          range: this.range(start),
          ctes,
          projections: [],
          relations,
          target,
          ...(where ? { where } : {}),
          ...(returning ? { returning } : {}),
        };
      } else if (this.accept("DESCRIBE") || this.accept("SUMMARIZE")) {
        const kind = this.tokens[this.index - 1]!.value.toUpperCase() === "DESCRIBE" ? "describe" : "summarize";
        const source = this.is("SELECT") || this.is("WITH") || this.is("FROM") ? this.statement() : undefined;
        const target = source ? undefined : this.qualified();
        result = {
          kind,
          range: this.range(start),
          ctes,
          projections: [],
          relations: [],
          ...(source ? { source } : {}),
          ...(target ? { target } : {}),
        };
      } else throw new DuckDBParseError("Unsupported or dynamic DuckDB statement", this.token().range, "TSQ401");
      return result;
    } finally {
      this.depth--;
    }
  }
  assignments(): { name: string; value: Expression }[] {
    return this.list(() => {
      const name = this.identifier().value;
      this.expect("=");
      return { name, value: this.expression() };
    });
  }
  select(start: SourceRange, ctes: readonly CommonTable[]): Statement {
    const fromFirst = this.accept("FROM"),
      initialRelations = fromFirst ? this.relations() : undefined;
    const explicitSelect = fromFirst ? this.accept("SELECT") : true;
    let distinct = false,
      distinctOn: Expression[] | undefined;
    if (explicitSelect) {
      if (!fromFirst) this.expect("SELECT");
      distinct = this.accept("DISTINCT");
      if (!distinct) this.accept("ALL");
      if (distinct && this.accept("ON")) {
        this.expect("(");
        distinctOn = this.list(() => this.expression(), ")");
      }
    }
    const projections = explicitSelect ? this.projections() : [{ expression: { kind: "star" as const, range: start } }];
    const relations = initialRelations ?? (this.accept("FROM") ? this.relations() : []),
      where = this.accept("WHERE") ? this.expression() : undefined;
    let group: Expression[] | undefined,
      groupAll = false;
    if (this.accept("GROUP")) {
      this.expect("BY");
      if (this.accept("ALL")) groupAll = true;
      else group = this.list(() => this.expression());
    }
    const having = this.accept("HAVING") ? this.expression() : undefined;
    const windows = this.accept("WINDOW")
      ? this.list(() => {
          const name = this.identifier().value;
          this.expect("AS");
          this.expect("(");
          return { name, ...this.windowSpec() };
        })
      : undefined;
    const qualify = this.accept("QUALIFY") ? this.expression() : undefined;
    let order: Expression[] | undefined;
    if (this.accept("ORDER")) {
      this.expect("BY");
      if (this.accept("ALL")) {
        this.accept("ASC") || this.accept("DESC");
      } else order = this.list(() => this.ordered());
    }
    let limit: Expression | undefined, offset: Expression | undefined;
    if (this.accept("LIMIT")) {
      limit = this.expression();
      if (this.accept("%"))
        throw new DuckDBParseError("Percentage LIMIT is not a fixed cardinality contract", limit.range, "TSQ401");
    }
    if (this.accept("OFFSET")) offset = this.expression();
    if (this.accept("FETCH")) {
      this.accept("FIRST") || this.expect("NEXT");
      limit = this.expression();
      this.accept("ROW") || this.expect("ROWS");
      this.expect("ONLY");
    }
    let set: Statement["set"];
    for (const operation of ["UNION", "INTERSECT", "EXCEPT"] as const) {
      if (this.accept(operation)) {
        const all = this.accept("ALL");
        if (!all) this.accept("DISTINCT");
        const byName = this.accept("BY");
        if (byName) this.expect("NAME");
        set = { operation, all, byName, right: this.statement() };
        break;
      }
    }
    return {
      kind: "select",
      range: this.range(start),
      ctes,
      projections,
      relations,
      ...(where ? { where } : {}),
      ...(group ? { group } : {}),
      ...(groupAll ? { groupAll } : {}),
      ...(having ? { having } : {}),
      ...(qualify ? { qualify } : {}),
      ...(order ? { order } : {}),
      ...(limit ? { limit } : {}),
      ...(offset ? { offset } : {}),
      ...(distinct ? { distinct } : {}),
      ...(distinctOn ? { distinctOn } : {}),
      ...(windows ? { windows } : {}),
      ...(set ? { set } : {}),
    };
  }
}
export function parseDuckDBStatement(source: string): Statement {
  const parser = new DuckDBParser(source),
    statement = parser.statement();
  parser.accept(";");
  if (parser.token().kind !== "eof")
    throw new DuckDBParseError("Unexpected SQL suffix or multiple statements", parser.token().range, "TSQ401");
  return statement;
}

/** Named frontend markers are contextual syntax: a STRUCT separator or slice colon is never a bind. */
export function duckDBParameterOccurrences(source: string) {
  const statement = parseDuckDBStatement(source),
    parameters: Expression[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("kind" in value && value.kind === "parameter") {
      parameters.push(value as Expression);
      return;
    }
    for (const item of Object.values(value)) {
      if (Array.isArray(item)) for (const child of item) visit(child);
      else visit(item);
    }
  };
  visit(statement);
  return parameters
    .sort((a, b) => a.range.start - b.range.start)
    .map((parameter) => {
      const text = source.slice(parameter.range.start, parameter.range.end),
        named = /^[$:][\p{L}_]/u.test(text);
      return {
        index: named ? 0 : Number(parameter.value),
        ...(named ? { name: text.slice(1) } : {}),
        range: parameter.range,
      };
    });
}
