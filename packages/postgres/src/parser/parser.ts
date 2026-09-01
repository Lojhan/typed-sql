import { SqlToolkitError, TokenCursor } from "@typed-sql/ast/toolkit";
import { SqlTokenizeError, type TokenizeOptions, tokenize } from "./tokenizer.js";
import {
  type BetweenExpression,
  type CaseBranch,
  type CommonTableExpression,
  type CompoundSelect,
  type DeleteStatement,
  type Expression,
  type GroupingElement,
  type Identifier,
  type InsertStatement,
  type JoinClause,
  type JoinKind,
  type JsonBehavior,
  type JsonFormat,
  type JsonPassingArgument,
  type JsonReturning,
  type JsonValueExpression,
  type MergeStatement,
  mergeRanges,
  type NamedTableReference,
  type NamedWindow,
  type OrderByItem,
  type QualifiedIdentifier,
  type SelectItem,
  type SelectLockingClause,
  type SelectStatement,
  type SourceRange,
  type Statement,
  type TableFunctionColumn,
  type TableFunctionItem,
  type TableReference,
  type Token,
  type TypeName,
  type UpdateAssignment,
  type UpdateStatement,
  type ValuesClause,
  type WindowFrameBound,
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
  ["AND", 2],
  ["=", 3],
  ["!=", 3],
  ["<>", 3],
  ["<", 3],
  ["<=", 3],
  [">", 3],
  [">=", 3],
  ["IS", 3],
  ["LIKE", 3],
  ["ILIKE", 3],
  ["SIMILAR TO", 3],
  ["~", 3],
  ["~*", 3],
  ["!~", 3],
  ["!~*", 3],
  ["@>", 3],
  ["<@", 3],
  ["?", 3],
  ["?|", 3],
  ["?&", 3],
  ["&&", 3],
  ["<<", 3],
  ["<<=", 3],
  [">>", 3],
  [">>=", 3],
  ["&<", 3],
  ["&>", 3],
  ["-\u007c-", 3],
  ["@?", 3],
  ["@@", 3],
  ["^@", 3],
  ["<<|", 3],
  ["|>>", 3],
  ["&<|", 3],
  ["|&>", 3],
  ["<^", 3],
  [">^", 3],
  ["?#", 3],
  ["?-", 3],
  ["?|", 3],
  ["?-|", 3],
  ["?||", 3],
  ["~=", 3],
  ["<->", 4],
  ["##", 4],
  ["||", 4],
  ["&", 4],
  ["|", 4],
  ["#", 4],
  ["->", 4],
  ["->>", 4],
  ["#>", 4],
  ["#>>", 4],
  ["#-", 4],
  ["+", 5],
  ["-", 5],
  ["*", 6],
  ["/", 6],
  ["%", 6],
  ["^", 7],
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
const intervalFields = new Set(["YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND"]);
const intervalFieldRanges = new Map<string, ReadonlySet<string>>([
  ["YEAR", new Set(["MONTH"])],
  ["DAY", new Set(["HOUR", "MINUTE", "SECOND"])],
  ["HOUR", new Set(["MINUTE", "SECOND"])],
  ["MINUTE", new Set(["SECOND"])],
]);
const simpleTypedLiteralTypes = new Set(["JSON", "JSONB", "JSONPATH"]);

class Parser {
  readonly #source: string;
  readonly #cursor: TokenCursor;
  readonly #syntax: string = "postgres";

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
      if (withClause === undefined && this.#current().value === "(") {
        const statement = this.#parseParenthesizedSelect();
        return this.#parseSelectTail(this.#parseCompoundExpression(statement, 0));
      }
      if (this.#current().value === "INSERT") return this.#parseInsert(withClause);
      if (this.#current().value === "UPDATE") return this.#parseUpdate(withClause);
      if (this.#current().value === "DELETE") return this.#parseDelete(withClause);
      if (this.#current().value === "MERGE") return this.#parseMerge(withClause);
      throw this.#error(
        `Expected SELECT, INSERT, UPDATE, DELETE, or MERGE, found ${this.#current().text || "end of query"}`,
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
      let materialization: CommonTableExpression["materialization"];
      if (this.#matchKeyword("NOT")) {
        this.#expectKeyword("MATERIALIZED");
        materialization = "not-materialized";
      } else if (this.#matchKeyword("MATERIALIZED")) materialization = "materialized";
      this.#expectPunctuation("(");
      const statement = this.#parseStatement();
      const close = this.#expectPunctuation(")");
      let search: CommonTableExpression["search"];
      if (this.#matchKeyword("SEARCH")) {
        const searchStart = this.#previous().range;
        let order: "breadth" | "depth";
        if (this.#matchKeyword("BREADTH")) order = "breadth";
        else if (this.#matchKeyword("DEPTH")) order = "depth";
        else throw this.#error("SEARCH requires BREADTH or DEPTH", this.#current().range);
        this.#expectKeyword("FIRST");
        this.#expectKeyword("BY");
        const by: Identifier[] = [];
        do by.push(this.#parseIdentifier());
        while (this.#matchPunctuation(","));
        this.#expectKeyword("SET");
        const set = this.#parseIdentifier();
        search = { order, by, set, range: mergeRanges(searchStart, set.range) };
      }
      let cycle: CommonTableExpression["cycle"];
      if (this.#matchKeyword("CYCLE")) {
        const cycleStart = this.#previous().range;
        const cycleColumns: Identifier[] = [];
        do cycleColumns.push(this.#parseIdentifier());
        while (this.#matchPunctuation(","));
        this.#expectKeyword("SET");
        const set = this.#parseIdentifier();
        let markValue: Expression | undefined;
        let markDefault: Expression | undefined;
        if (this.#matchKeyword("TO")) {
          markValue = this.#parseExpression();
          this.#expectKeyword("DEFAULT");
          markDefault = this.#parseExpression();
        }
        this.#expectKeyword("USING");
        const using = this.#parseIdentifier();
        cycle = {
          columns: cycleColumns,
          set,
          ...(markValue === undefined ? {} : { markValue }),
          ...(markDefault === undefined ? {} : { markDefault }),
          using,
          range: mergeRanges(cycleStart, using.range),
        };
      }
      queries.push({
        name,
        columns,
        statement,
        ...(materialization === undefined ? {} : { materialization }),
        ...(search === undefined ? {} : { search }),
        ...(cycle === undefined ? {} : { cycle }),
        range: mergeRanges(name.range, cycle?.range ?? search?.range ?? close.range),
      });
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
    let groupModifier: "all" | "distinct" | undefined;
    const groupBy: GroupingElement[] = [];
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
      if (this.#matchKeyword("ALL")) groupModifier = "all";
      else if (this.#matchKeyword("DISTINCT")) groupModifier = "distinct";
      groupBy.push(...this.#parseGroupingList());
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
      ...(groupModifier === undefined ? {} : { groupModifier }),
      groupBy,
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
    return { ...statement, range: mergeRanges(open.range, close.range) };
  }

  #parseCompoundExpression(initial: SelectStatement, minimumPrecedence: number): SelectStatement {
    let statement = initial;
    while (["UNION", "INTERSECT", "EXCEPT"].includes(this.#current().value)) {
      const precedence = this.#current().value === "INTERSECT" ? 2 : 1;
      if (precedence < minimumPrecedence) break;
      const operatorToken = this.#current();
      this.#advance();
      const all = this.#matchKeyword("ALL");
      if (this.#syntax === "sqlite" && all && operatorToken.value !== "UNION") {
        throw this.#error(`SQLite does not support ${operatorToken.value} ALL`, this.#previous().range);
      }
      const right =
        this.#current().value === "(" ? this.#parseParenthesizedSelect() : this.#parseSelect(undefined, precedence + 1);
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
    let limitAll = false;
    let offset: Expression | undefined;
    let fetch: SelectStatement["fetch"];
    const locking: SelectLockingClause[] = [];
    if (this.#matchKeyword("ORDER")) {
      this.#expectKeyword("BY");
      orderBy = this.#parseOrderByList();
    }
    if (this.#matchKeyword("LIMIT")) {
      if (this.#matchKeyword("ALL")) limitAll = true;
      else limit = this.#parseExpression();
      if (this.#syntax !== "postgres" && this.#matchPunctuation(",")) {
        offset = limit;
        limit = this.#parseExpression();
      }
    }
    if (this.#matchKeyword("OFFSET")) {
      offset = this.#parseExpression();
      this.#matchKeyword("ROW") || this.#matchKeyword("ROWS");
    }
    if (this.#matchKeyword("FETCH")) {
      const fetchStart = this.#previous().range;
      if (!this.#matchKeyword("FIRST")) this.#expectKeyword("NEXT");
      const count = ["ROW", "ROWS"].includes(this.#current().value) ? undefined : this.#parseExpression();
      if (!this.#matchKeyword("ROW")) this.#expectKeyword("ROWS");
      let withTies = false;
      if (this.#matchKeyword("WITH")) {
        this.#expectKeyword("TIES");
        withTies = true;
      } else this.#expectKeyword("ONLY");
      fetch = {
        ...(count === undefined ? {} : { count }),
        withTies,
        range: mergeRanges(fetchStart, this.#previous().range),
      };
    }
    while (this.#current().value === "FOR") locking.push(this.#parseSelectLockingClause());
    if (this.#current().value === "LOCK") {
      if (this.#syntax !== "mysql") throw this.#error("LOCK IN SHARE MODE is MySQL syntax", this.#current().range);
      if (locking.length > 0) {
        throw this.#error("LOCK IN SHARE MODE cannot follow another MySQL locking clause", this.#current().range);
      }
      const lockStart = this.#expectKeyword("LOCK").range;
      this.#expectKeyword("IN");
      this.#expectKeyword("SHARE");
      const lockEnd = this.#expectKeyword("MODE").range;
      locking.push({ strength: "share", relations: [], range: mergeRanges(lockStart, lockEnd) });
    }
    const end = this.#previous().range;
    return {
      ...statement,
      orderBy,
      ...(limit === undefined ? {} : { limit }),
      ...(limitAll ? { limitAll: true as const } : {}),
      ...(offset === undefined ? {} : { offset }),
      ...(fetch === undefined ? {} : { fetch }),
      locking,
      range: mergeRanges(statement.range, end),
    };
  }

  #parseSelectLockingClause(): SelectLockingClause {
    const start = this.#expectKeyword("FOR").range;
    let strength: SelectLockingClause["strength"];
    if (this.#matchKeyword("UPDATE")) strength = "update";
    else if (this.#matchKeyword("SHARE")) strength = "share";
    else if (this.#matchKeyword("NO")) {
      if (this.#syntax !== "postgres") throw this.#error("FOR NO KEY UPDATE is PostgreSQL syntax", start);
      this.#expectKeyword("KEY");
      this.#expectKeyword("UPDATE");
      strength = "no-key-update";
    } else if (this.#matchKeyword("KEY")) {
      if (this.#syntax !== "postgres") throw this.#error("FOR KEY SHARE is PostgreSQL syntax", start);
      this.#expectKeyword("SHARE");
      strength = "key-share";
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
    let overriding: InsertStatement["overriding"];
    if (this.#matchKeyword("OVERRIDING")) {
      if (this.#matchWord("SYSTEM")) overriding = "system";
      else {
        this.#expectWord("USER");
        overriding = "user";
      }
      this.#expectWord("VALUE");
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
    const conflict = this.#matchKeyword("ON") ? this.#parseInsertConflictClause() : undefined;
    const { aliases: returningAliases, items: returning } = this.#parseReturning();
    return {
      kind: "insert",
      ...(withClause === undefined ? {} : { with: withClause }),
      table,
      columns,
      ...(overriding === undefined ? {} : { overriding }),
      source,
      ...(conflict === undefined ? {} : { conflict }),
      ...(returningAliases === undefined ? {} : { returningAliases }),
      returning,
      range: mergeRanges(start, this.#previous().range),
    };
  }

  #parseUpdate(withClause?: WithClause): UpdateStatement {
    const start = withClause?.range ?? this.#expectKeyword("UPDATE").range;
    if (withClause !== undefined) this.#expectKeyword("UPDATE");
    const table = this.#parseNamedTableReference(true);
    this.#expectKeyword("SET");
    const assignments = this.#parseUpdateAssignments();
    let from: TableReference | undefined;
    const joins: JoinClause[] = [];
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
    let where: Expression | undefined;
    let currentOf: UpdateStatement["currentOf"];
    if (this.#matchKeyword("WHERE")) {
      const whereStart = this.#previous().range;
      if (this.#matchKeyword("CURRENT")) {
        this.#expectKeyword("OF");
        const cursor = this.#parseIdentifier(true);
        currentOf = { cursor, range: mergeRanges(whereStart, cursor.range) };
      } else where = this.#parseExpression();
    }
    const { aliases: returningAliases, items: returning } = this.#parseReturning();
    return {
      kind: "update",
      ...(withClause === undefined ? {} : { with: withClause }),
      table,
      assignments,
      ...(from === undefined ? {} : { from }),
      joins,
      ...(where === undefined ? {} : { where }),
      ...(currentOf === undefined ? {} : { currentOf }),
      ...(returningAliases === undefined ? {} : { returningAliases }),
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
    const joins: JoinClause[] = [];
    if (this.#matchKeyword("USING")) {
      using.push(this.#parseTableReference());
      while (true) {
        if (this.#matchPunctuation(",")) using.push(this.#parseTableReference());
        else if (this.#isJoinStart()) joins.push(this.#parseJoin());
        else break;
      }
    }
    let where: Expression | undefined;
    let currentOf: DeleteStatement["currentOf"];
    if (this.#matchKeyword("WHERE")) {
      const whereStart = this.#previous().range;
      if (this.#matchKeyword("CURRENT")) {
        this.#expectKeyword("OF");
        const cursor = this.#parseIdentifier(true);
        currentOf = { cursor, range: mergeRanges(whereStart, cursor.range) };
      } else where = this.#parseExpression();
    }
    const { aliases: returningAliases, items: returning } = this.#parseReturning();
    return {
      kind: "delete",
      ...(withClause === undefined ? {} : { with: withClause }),
      table,
      using,
      joins,
      ...(where === undefined ? {} : { where }),
      ...(currentOf === undefined ? {} : { currentOf }),
      ...(returningAliases === undefined ? {} : { returningAliases }),
      returning,
      range: mergeRanges(start, this.#previous().range),
    };
  }

  #parseMerge(withClause?: WithClause): MergeStatement {
    const start = withClause?.range ?? this.#expectKeyword("MERGE").range;
    if (withClause !== undefined) this.#expectKeyword("MERGE");
    this.#expectKeyword("INTO");
    const table = this.#parseNamedTableReference(true);
    this.#expectKeyword("USING");
    const source = this.#parseMergeSource();
    this.#expectKeyword("ON");
    const on = this.#parseExpression();
    const clauses: MergeStatement["clauses"][number][] = [];
    while (this.#matchKeyword("WHEN")) {
      const clauseStart = this.#previous().range;
      let match: MergeStatement["clauses"][number]["match"];
      let by: MergeStatement["clauses"][number]["by"];
      if (this.#matchKeyword("MATCHED")) match = "matched";
      else {
        this.#expectKeyword("NOT");
        this.#expectKeyword("MATCHED");
        if (this.#matchKeyword("BY")) {
          if (this.#matchWord("SOURCE")) {
            match = "not-matched-source";
            by = "source";
          } else {
            this.#expectWord("TARGET");
            match = "not-matched-target";
            by = "target";
          }
        } else match = "not-matched-target";
      }
      const condition = this.#matchKeyword("AND") ? this.#parseExpression() : undefined;
      this.#expectKeyword("THEN");
      let action: MergeStatement["clauses"][number]["action"];
      if (this.#matchKeyword("DO")) {
        this.#expectKeyword("NOTHING");
        action = { kind: "nothing", range: mergeRanges(clauseStart, this.#previous().range) };
      } else if (this.#matchKeyword("DELETE")) {
        action = { kind: "delete", range: mergeRanges(clauseStart, this.#previous().range) };
      } else if (this.#matchKeyword("UPDATE")) {
        this.#expectKeyword("SET");
        const assignments = this.#parseUpdateAssignments();
        action = {
          kind: "update",
          assignments,
          range: mergeRanges(clauseStart, assignments.at(-1)?.range ?? clauseStart),
        };
      } else {
        this.#expectKeyword("INSERT");
        const columns: Identifier[] = [];
        if (this.#matchPunctuation("(")) {
          do columns.push(this.#parseIdentifier());
          while (this.#matchPunctuation(","));
          this.#expectPunctuation(")");
        }
        let overriding: "system" | "user" | undefined;
        if (this.#matchKeyword("OVERRIDING")) {
          if (this.#matchWord("SYSTEM")) overriding = "system";
          else {
            this.#expectWord("USER");
            overriding = "user";
          }
          this.#expectWord("VALUE");
        }
        let actionSource: ValuesClause | { readonly kind: "default-values"; readonly range: SourceRange };
        if (this.#matchKeyword("DEFAULT")) {
          const sourceStart = this.#previous().range;
          const end = this.#expectKeyword("VALUES").range;
          actionSource = { kind: "default-values", range: mergeRanges(sourceStart, end) };
        } else {
          const sourceStart = this.#expectKeyword("VALUES").range;
          this.#expectPunctuation("(");
          const row = this.#matchPunctuation(")") ? [] : [...this.#parseExpressionList()];
          const close = this.#previous().value === ")" ? this.#previous() : this.#expectPunctuation(")");
          actionSource = { kind: "values", rows: [row], range: mergeRanges(sourceStart, close.range) };
        }
        action = {
          kind: "insert",
          columns,
          ...(overriding === undefined ? {} : { overriding }),
          source: actionSource,
          range: mergeRanges(clauseStart, actionSource.range),
        };
      }
      clauses.push({
        match,
        ...(by === undefined ? {} : { by }),
        ...(condition === undefined ? {} : { condition }),
        action,
        range: mergeRanges(clauseStart, action.range),
      });
    }
    if (clauses.length === 0) throw this.#error("MERGE requires at least one WHEN clause", this.#current().range);
    const { aliases: returningAliases, items: returning } = this.#parseReturning();
    return {
      kind: "merge",
      ...(withClause === undefined ? {} : { with: withClause }),
      table,
      source,
      on,
      clauses,
      ...(returningAliases === undefined ? {} : { returningAliases }),
      returning,
      range: mergeRanges(start, this.#previous().range),
    };
  }

  #parseInsertConflictClause(): InsertStatement["conflict"] {
    const start = this.#previous().range;
    this.#expectKeyword("CONFLICT");
    let target: NonNullable<InsertStatement["conflict"]>["target"];
    if (this.#matchKeyword("ON")) {
      this.#expectKeyword("CONSTRAINT");
      const constraint = this.#parseIdentifier(true);
      target = { kind: "constraint", constraint, range: mergeRanges(start, constraint.range) };
    } else if (this.#matchPunctuation("(")) {
      const elements = [];
      do {
        const elementStart = this.#current().range;
        let expression = this.#parseExpression();
        let collation: QualifiedIdentifier | undefined;
        if (expression.kind === "collate") {
          collation = expression.collation;
          expression = expression.expression;
        } else if (this.#matchKeyword("COLLATE")) collation = this.#parseQualifiedIdentifier();
        const operatorClass =
          this.#current().value !== "," && this.#current().value !== ")" ? this.#parseQualifiedIdentifier() : undefined;
        elements.push({
          expression,
          ...(collation === undefined ? {} : { collation }),
          ...(operatorClass === undefined ? {} : { operatorClass }),
          range: mergeRanges(elementStart, operatorClass?.range ?? collation?.range ?? expression.range),
        });
      } while (this.#matchPunctuation(","));
      const close = this.#expectPunctuation(")");
      const predicate = this.#matchKeyword("WHERE") ? this.#parseExpression() : undefined;
      target = {
        kind: "inference",
        elements,
        ...(predicate === undefined ? {} : { predicate }),
        range: mergeRanges(start, predicate?.range ?? close.range),
      };
    }
    this.#expectKeyword("DO");
    let action: NonNullable<InsertStatement["conflict"]>["action"];
    if (this.#matchKeyword("NOTHING")) {
      action = { kind: "nothing", range: mergeRanges(start, this.#previous().range) };
    } else {
      this.#expectKeyword("UPDATE");
      this.#expectKeyword("SET");
      const assignments = this.#parseUpdateAssignments();
      const where = this.#matchKeyword("WHERE") ? this.#parseExpression() : undefined;
      action = {
        kind: "update",
        assignments,
        ...(where === undefined ? {} : { where }),
        range: mergeRanges(start, where?.range ?? assignments.at(-1)?.range ?? start),
      };
    }
    return { ...(target === undefined ? {} : { target }), action, range: mergeRanges(start, action.range) };
  }

  #parseMergeSource(): MergeStatement["source"] {
    const start = this.#current().range;
    if (this.#current().value !== "(" || this.#peekToken(1).value !== "VALUES") return this.#parseTableReference();
    this.#expectPunctuation("(");
    this.#expectKeyword("VALUES");
    const rows: Expression[][] = [];
    do {
      this.#expectPunctuation("(");
      const row = this.#matchPunctuation(")") ? [] : [...this.#parseExpressionList()];
      if (this.#previous().value !== ")") this.#expectPunctuation(")");
      rows.push(row);
    } while (this.#matchPunctuation(","));
    this.#expectPunctuation(")");
    let alias: Identifier | undefined;
    if (this.#matchKeyword("AS")) alias = this.#parseIdentifier(true);
    else if (this.#current().kind === "identifier" || this.#current().kind === "quoted-identifier")
      alias = this.#parseIdentifier();
    const columns: Identifier[] = [];
    if (alias !== undefined && this.#matchPunctuation("(")) {
      do columns.push(this.#parseIdentifier());
      while (this.#matchPunctuation(","));
      this.#expectPunctuation(")");
    }
    return {
      kind: "values",
      rows,
      ...(alias === undefined ? {} : { alias }),
      columns,
      range: mergeRanges(start, this.#previous().range),
    };
  }

  #parseUpdateAssignments(): readonly UpdateAssignment[] {
    const assignments: UpdateAssignment[] = [];
    do {
      if (this.#matchPunctuation("(")) {
        const start = this.#previous().range;
        const columns: Identifier[] = [];
        do columns.push(this.#parseIdentifier());
        while (this.#matchPunctuation(","));
        this.#expectPunctuation(")");
        this.#expectOperator("=");
        const value = this.#matchKeyword("ROW")
          ? (() => {
              const rowStart = this.#previous().range;
              this.#expectPunctuation("(");
              const elements = [...this.#parseExpressionList()];
              const close = this.#expectPunctuation(")");
              return { kind: "row", elements, range: mergeRanges(rowStart, close.range) } as const;
            })()
          : this.#parseExpression();
        assignments.push({ columns, value, range: mergeRanges(start, value.range) });
      } else {
        const column = this.#parseIdentifier();
        this.#expectOperator("=");
        const value = this.#parseExpression();
        assignments.push({ column, value, range: mergeRanges(column.range, value.range) });
      }
    } while (this.#matchPunctuation(","));
    return assignments;
  }

  #parseReturning(): { readonly aliases?: InsertStatement["returningAliases"]; readonly items: readonly SelectItem[] } {
    if (!this.#matchKeyword("RETURNING")) return { items: [] };
    let aliases: InsertStatement["returningAliases"];
    if (this.#matchKeyword("WITH")) {
      const start = this.#previous().range;
      this.#expectPunctuation("(");
      let oldAlias: Identifier | undefined;
      let newAlias: Identifier | undefined;
      do {
        const kind = this.#current().value;
        if (kind !== "OLD" && kind !== "NEW")
          throw this.#error("RETURNING aliases require OLD or NEW", this.#current().range);
        this.#advance();
        this.#expectKeyword("AS");
        const alias = this.#parseIdentifier(true);
        if (kind === "OLD") oldAlias = alias;
        else newAlias = alias;
      } while (this.#matchPunctuation(","));
      const close = this.#expectPunctuation(")");
      aliases = {
        ...(oldAlias === undefined ? {} : { old: oldAlias }),
        ...(newAlias === undefined ? {} : { new: newAlias }),
        range: mergeRanges(start, close.range),
      };
    }
    return { ...(aliases === undefined ? {} : { aliases }), items: this.#parseSelectList() };
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
      const close = this.#expectPunctuation(")");
      let alias: Identifier | undefined;
      if (this.#matchKeyword("AS")) alias = this.#parseIdentifier(true);
      else if (this.#current().kind === "identifier" || this.#current().kind === "quoted-identifier")
        alias = this.#parseIdentifier();
      const columns: Identifier[] = [];
      if (alias !== undefined && this.#matchPunctuation("(")) {
        do columns.push(this.#parseIdentifier());
        while (this.#matchPunctuation(","));
        this.#expectPunctuation(")");
      }
      return {
        kind: "subquery",
        query: statement,
        ...(alias === undefined ? {} : { alias }),
        columns,
        lateral,
        range: mergeRanges(start, alias === undefined ? close.range : this.#previous().range),
      };
    }
    if (this.#current().value === "ROWS" || this.#isTableFunctionStart()) {
      return this.#parseFunctionTableReference(lateral, start);
    }
    return this.#parseNamedTableReference(true, lateral, start);
  }

  #isTableFunctionStart(): boolean {
    if (!this.#isIdentifierLike(this.#current())) return false;
    if (this.#peekToken(1).value === "(") return true;
    return (
      this.#peekToken(1).value === "." && this.#isIdentifierLike(this.#peekToken(2)) && this.#peekToken(3).value === "("
    );
  }

  #parseFunctionTableReference(lateral: boolean, start: SourceRange): TableReference {
    const functions: TableFunctionItem[] = [];
    const rowsFrom = this.#matchKeyword("ROWS");
    if (rowsFrom) {
      this.#expectKeyword("FROM");
      this.#expectPunctuation("(");
      do functions.push(this.#parseTableFunctionItem(true));
      while (this.#matchPunctuation(","));
      this.#expectPunctuation(")");
    } else functions.push(this.#parseTableFunctionItem(false));
    const withOrdinality = this.#matchKeyword("WITH");
    if (withOrdinality) this.#expectKeyword("ORDINALITY");
    const hasAs = this.#matchKeyword("AS");
    const alias = this.#isIdentifierLike(this.#current()) ? this.#parseIdentifier(true) : undefined;
    if (hasAs && alias === undefined && this.#current().value !== "(") {
      throw this.#error("Expected table-function alias or column definition list", this.#current().range);
    }
    const columns = this.#matchPunctuation("(") ? this.#parseTableFunctionColumns(false) : [];
    return {
      kind: "function",
      ...(rowsFrom ? { rowsFrom: true as const } : {}),
      functions,
      withOrdinality,
      ...(alias === undefined ? {} : { alias }),
      columns,
      lateral,
      range: mergeRanges(start, this.#previous().range),
    };
  }

  #parseTableFunctionItem(allowDefinition: boolean): TableFunctionItem {
    const first = this.#parseIdentifier(true);
    let schema: Identifier | undefined;
    let name = first;
    if (this.#matchPunctuation(".")) {
      schema = first;
      name = this.#parseIdentifier(true);
    }
    this.#expectPunctuation("(");
    const expression = this.#parseCall(schema, name);
    if (expression.kind !== "call") throw this.#error("FROM function must be a routine call", expression.range);
    let columns: readonly TableFunctionColumn[] = [];
    if (allowDefinition && this.#current().value === "AS" && this.#peekToken(1).value === "(") {
      this.#advance();
      this.#expectPunctuation("(");
      columns = this.#parseTableFunctionColumns(true);
    }
    return { call: expression, columns, range: mergeRanges(first.range, this.#previous().range) };
  }

  #parseTableFunctionColumns(requireTypes: boolean): readonly TableFunctionColumn[] {
    const columns: TableFunctionColumn[] = [];
    if (!this.#matchPunctuation(")")) {
      do {
        const name = this.#parseIdentifier(true);
        const databaseType =
          requireTypes || (this.#current().value !== "," && this.#current().value !== ")")
            ? this.#parseTypeName(false)
            : undefined;
        columns.push({
          name,
          ...(databaseType === undefined ? {} : { databaseType }),
          range: mergeRanges(name.range, databaseType?.range ?? name.range),
        });
      } while (this.#matchPunctuation(","));
      this.#expectPunctuation(")");
    }
    return columns;
  }

  #parseNamedTableReference(allowAlias: boolean, lateral = false, start = this.#current().range): NamedTableReference {
    const only = this.#matchKeyword("ONLY");
    const first = this.#parseIdentifier();
    let schema: Identifier | undefined;
    let name = first;
    if (this.#matchPunctuation(".")) {
      schema = first;
      name = this.#parseIdentifier();
    }
    const includeDescendants = this.#matchOperator("*");
    let alias: Identifier | undefined;
    if (allowAlias && this.#matchKeyword("AS")) alias = this.#parseIdentifier(true);
    else if (allowAlias && (this.#current().kind === "identifier" || this.#current().kind === "quoted-identifier"))
      alias = this.#parseIdentifier();
    let sample: NamedTableReference["sample"];
    if (allowAlias && this.#matchKeyword("TABLESAMPLE")) {
      const sampleStart = this.#previous().range;
      const method = this.#parseIdentifier(true);
      this.#expectPunctuation("(");
      const empty = this.#matchPunctuation(")");
      const argumentsList = empty ? [] : [...this.#parseExpressionList()];
      if (!empty) this.#expectPunctuation(")");
      let repeatable: Expression | undefined;
      if (this.#matchKeyword("REPEATABLE")) {
        this.#expectPunctuation("(");
        repeatable = this.#parseExpression();
        this.#expectPunctuation(")");
      }
      sample = {
        method,
        arguments: argumentsList,
        ...(repeatable === undefined ? {} : { repeatable }),
        range: mergeRanges(sampleStart, this.#previous().range),
      };
    }
    return {
      kind: "table",
      name,
      ...(schema === undefined ? {} : { schema }),
      ...(alias === undefined ? {} : { alias }),
      lateral,
      ...(only ? { only: true as const } : {}),
      ...(includeDescendants ? { includeDescendants: true as const } : {}),
      ...(sample === undefined ? {} : { sample }),
      range: mergeRanges(start, sample?.range ?? alias?.range ?? name.range),
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

  #parseGroupingList(): readonly GroupingElement[] {
    const elements: GroupingElement[] = [];
    do elements.push(this.#parseGroupingElement());
    while (this.#matchPunctuation(","));
    return elements;
  }

  #parseGroupingElement(): GroupingElement {
    if (this.#matchPunctuation("(")) {
      const start = this.#previous().range;
      if (this.#matchPunctuation(")")) {
        return { kind: "empty-group", range: mergeRanges(start, this.#previous().range) };
      }
      const elements = this.#parseGroupingList();
      const close = this.#expectPunctuation(")");
      return { kind: "grouping-set", elements, range: mergeRanges(start, close.range) };
    }
    let kind: "rollup" | "cube" | "grouping-sets" | undefined;
    let start: SourceRange | undefined;
    if (this.#matchKeyword("ROLLUP")) {
      kind = "rollup";
      start = this.#previous().range;
    } else if (this.#matchKeyword("CUBE")) {
      kind = "cube";
      start = this.#previous().range;
    } else if (this.#matchKeyword("GROUPING")) {
      start = this.#previous().range;
      this.#expectKeyword("SETS");
      kind = "grouping-sets";
    }
    if (kind !== undefined && start !== undefined) {
      this.#expectPunctuation("(");
      const empty = this.#matchPunctuation(")");
      const elements = empty ? [] : [...this.#parseGroupingList()];
      const close = empty ? this.#previous() : this.#expectPunctuation(")");
      return { kind, elements, range: mergeRanges(start, close.range) };
    }
    return this.#parseExpression();
  }

  #parseOrderByList(): OrderByItem[] {
    const orderBy: OrderByItem[] = [];
    do {
      const expression = this.#parseExpression();
      const direction = this.#matchKeyword("ASC") ? "asc" : this.#matchKeyword("DESC") ? "desc" : undefined;
      let using: string | undefined;
      if (direction === undefined && this.#matchKeyword("USING")) {
        const operator = this.#expect("operator", "ordering operator");
        using = operator.value;
      }
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
        ...(using === undefined ? {} : { using }),
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
        if (this.#current().value === ".") {
          left = this.#parseFieldAccess(left);
          continue;
        }
        if (this.#current().value === "[") {
          left = this.#parseSubscript(left);
          continue;
        }
        if (this.#syntax === "postgres" && this.#matchOperator("::")) {
          const databaseType = this.#parseTypeName(false);
          left = {
            kind: "cast",
            expression: left,
            databaseType,
            syntax: "postgres",
            range: mergeRanges(left.range, databaseType.range),
          };
          continue;
        }
        if (this.#syntax === "postgres" && this.#matchKeyword("COLLATE")) {
          const collation = this.#parseQualifiedIdentifier();
          left = {
            kind: "collate",
            expression: left,
            collation,
            range: mergeRanges(left.range, collation.range),
          };
          continue;
        }
        if (this.#syntax === "postgres" && this.#current().value === "AT") {
          const strength = 8;
          if (strength < minimum) break;
          this.#advance();
          if (this.#matchKeyword("TIME")) {
            this.#expectKeyword("ZONE");
            const zone = this.#parseExpression(strength + 1);
            left = {
              kind: "at-time-zone",
              expression: left,
              zone,
              local: false,
              range: mergeRanges(left.range, zone.range),
            };
          } else {
            const local = this.#expectKeyword("LOCAL");
            left = {
              kind: "at-time-zone",
              expression: left,
              local: true,
              range: mergeRanges(left.range, local.range),
            };
          }
          continue;
        }

        const negated =
          this.#current().value === "NOT" &&
          ["IN", "BETWEEN", "LIKE", "ILIKE", "SIMILAR"].includes(this.#peekToken(1).value);
        const special = negated ? this.#peekToken(1).value : this.#current().value;
        if (special === "IN") {
          const strength = 3;
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
          const close = this.#expectPunctuation(")");
          left = { kind: "in", expression: left, values, negated, range: mergeRanges(start, close.range) };
          continue;
        }
        if (special === "BETWEEN") {
          const strength = 3;
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
        if (special === "SIMILAR") operator = negated ? "NOT SIMILAR TO" : "SIMILAR TO";
        else if (negated) operator = `NOT ${special}`;
        const strength = precedence.get(operator.replace(/^NOT /u, ""));
        if (strength === undefined || strength < minimum) break;
        if (negated) this.#advance();
        this.#advance();
        if (operator.endsWith("SIMILAR TO")) this.#expectKeyword("TO");
        if (operator === "IS") {
          if (this.#matchKeyword("NOT")) operator = "IS NOT";
          if (this.#matchKeyword("DISTINCT")) {
            this.#expectKeyword("FROM");
            operator += " DISTINCT FROM";
          }
        }
        if (this.#syntax === "postgres" && ["ANY", "SOME", "ALL"].includes(this.#current().value)) {
          const quantifier = this.#advance().value.toLowerCase() as "any" | "some" | "all";
          this.#expectPunctuation("(");
          let right: Expression | SelectStatement;
          if (this.#isStatementStart()) {
            const statement = this.#parseStatement();
            if (statement.kind !== "select")
              throw this.#error(`${quantifier.toUpperCase()} requires a SELECT subquery`, statement.range);
            right = statement;
          } else right = this.#parseExpression();
          const close = this.#expectPunctuation(")");
          left = {
            kind: "quantified-comparison",
            left,
            operator,
            quantifier,
            right,
            range: mergeRanges(left.range, close.range),
          };
          continue;
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
      this.#matchOperator("+") ||
      this.#matchOperator("-") ||
      this.#matchOperator("~") ||
      this.#matchOperator("!!") ||
      this.#matchOperator("@-@") ||
      this.#matchOperator("@@") ||
      this.#matchOperator("#") ||
      this.#matchOperator("?-") ||
      this.#matchOperator("?|") ||
      this.#matchOperator("@") ||
      this.#matchOperator("|/") ||
      this.#matchOperator("||/")
    ) {
      const expression = this.#parseUnary();
      return {
        kind: "unary",
        operator: token.value.toUpperCase(),
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
    while (this.#current().value === "[" || this.#current().value === ".") {
      expression =
        this.#current().value === "[" ? this.#parseSubscript(expression) : this.#parseFieldAccess(expression);
    }
    return expression;
  }

  #parseFieldAccess(expression: Expression): Expression {
    this.#expectPunctuation(".");
    const field = this.#parseIdentifier(true);
    return { kind: "field-access", expression, field, range: mergeRanges(expression.range, field.range) };
  }

  #parseSubscript(expression: Expression): Expression {
    this.#expectPunctuation("[");
    let index: Expression | undefined;
    let lower: Expression | undefined;
    let upper: Expression | undefined;
    let slice = false;
    if (this.#matchPunctuation(":")) {
      slice = true;
      if (this.#current().value !== "]") upper = this.#parseExpression();
    } else {
      if (this.#current().value === "]") throw this.#error("Array subscript cannot be empty", this.#current().range);
      const first = this.#parseExpression();
      if (this.#matchPunctuation(":")) {
        slice = true;
        lower = first;
        if (this.#current().value !== "]") upper = this.#parseExpression();
      } else index = first;
    }
    const close = this.#expectPunctuation("]");
    return {
      kind: "subscript",
      expression,
      ...(index === undefined ? {} : { index }),
      ...(lower === undefined ? {} : { lower }),
      ...(upper === undefined ? {} : { upper }),
      slice,
      range: mergeRanges(expression.range, close.range),
    };
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
    if (this.#isIntervalLiteralStart()) return this.#parseIntervalLiteral();
    if (simpleTypedLiteralTypes.has(token.value) && this.#peekToken(1).kind === "string") {
      return this.#parseSimpleTypedLiteral();
    }
    if (this.#isWord(token, "JSON_EXISTS") && this.#peekToken(1).value === "(") {
      this.#advance();
      return this.#parseJsonExists(token);
    }
    if (this.#isWord(token, "JSON_QUERY") && this.#peekToken(1).value === "(") {
      this.#advance();
      return this.#parseJsonQuery(token);
    }
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

  #parseJsonExists(start: Token): Expression {
    this.#expectPunctuation("(");
    const context = this.#parseJsonValueExpression();
    this.#expectPunctuation(",");
    const path = this.#parseExpression();
    const passing = this.#parseJsonPassing();
    let onError: "true" | "false" | "unknown" | "error" | undefined;
    if (
      ["TRUE", "FALSE", "UNKNOWN", "ERROR"].some((word) => this.#isWord(this.#current(), word)) &&
      this.#isWord(this.#peekToken(1), "ON") &&
      this.#isWord(this.#peekToken(2), "ERROR")
    ) {
      onError = this.#advance().value.toLowerCase() as typeof onError;
      this.#expectKeyword("ON");
      this.#expectWord("ERROR");
    }
    const close = this.#expectPunctuation(")");
    return {
      kind: "json-exists",
      context,
      path,
      passing,
      ...(onError === undefined ? {} : { onError }),
      range: mergeRanges(start.range, close.range),
    };
  }

  #parseJsonQuery(start: Token): Expression {
    this.#expectPunctuation("(");
    const context = this.#parseJsonValueExpression();
    this.#expectPunctuation(",");
    const path = this.#parseExpression();
    const passing = this.#parseJsonPassing();
    let returning: JsonReturning | undefined;
    if (this.#matchKeyword("RETURNING")) {
      const returningStart = this.#previous();
      const databaseType = this.#parseTypeName(false, () => this.#isJsonQueryClauseStart());
      const format = this.#parseJsonFormat();
      returning = {
        databaseType,
        ...(format === undefined ? {} : { format }),
        range: mergeRanges(returningStart.range, format?.range ?? databaseType.range),
      };
    }
    let wrapper: "without" | "conditional" | "unconditional" | undefined;
    if (this.#matchWord("WITHOUT")) {
      wrapper = "without";
      this.#matchKeyword("ARRAY");
      this.#expectWord("WRAPPER");
    } else if (this.#matchWord("WITH")) {
      wrapper = this.#matchWord("CONDITIONAL") ? "conditional" : "unconditional";
      if (wrapper === "unconditional") this.#matchWord("UNCONDITIONAL");
      this.#matchKeyword("ARRAY");
      this.#expectWord("WRAPPER");
    }
    let quotes: "keep" | "omit" | undefined;
    if (this.#matchWord("KEEP") || this.#matchWord("OMIT")) {
      quotes = this.#previous().value.toLowerCase() as typeof quotes;
      this.#expectWord("QUOTES");
      if (this.#matchKeyword("ON")) {
        this.#expectWord("SCALAR");
        this.#expectWord("STRING");
      }
    }
    let onEmpty: JsonBehavior | undefined;
    let onError: JsonBehavior | undefined;
    if (this.#isJsonQueryBehaviorStart()) {
      const clause = this.#parseJsonBehaviorClause();
      if (clause.target === "empty") onEmpty = clause.behavior;
      else onError = clause.behavior;
    }
    if (onEmpty !== undefined && this.#isJsonQueryBehaviorStart()) {
      const clause = this.#parseJsonBehaviorClause();
      if (clause.target !== "error") {
        throw this.#error("JSON_QUERY ON EMPTY must precede ON ERROR", clause.behavior.range);
      }
      onError = clause.behavior;
    }
    const close = this.#expectPunctuation(")");
    return {
      kind: "json-query",
      context,
      path,
      passing,
      ...(returning === undefined ? {} : { returning }),
      ...(wrapper === undefined ? {} : { wrapper }),
      ...(quotes === undefined ? {} : { quotes }),
      ...(onEmpty === undefined ? {} : { onEmpty }),
      ...(onError === undefined ? {} : { onError }),
      range: mergeRanges(start.range, close.range),
    };
  }

  #parseJsonPassing(): JsonPassingArgument[] {
    const passing: JsonPassingArgument[] = [];
    if (!this.#matchWord("PASSING")) return passing;
    do {
      const value = this.#parseJsonValueExpression();
      this.#expectKeyword("AS");
      const name = this.#parseIdentifier(true);
      passing.push({ value, name, range: mergeRanges(value.range, name.range) });
    } while (this.#matchPunctuation(","));
    return passing;
  }

  #parseJsonValueExpression(): JsonValueExpression {
    const expression = this.#parseExpression();
    const format = this.#parseJsonFormat();
    if (format === undefined) return { expression, range: expression.range };
    return { expression, format, range: mergeRanges(expression.range, format.range) };
  }

  #parseJsonFormat(): JsonFormat | undefined {
    if (!this.#matchWord("FORMAT")) return undefined;
    const formatStart = this.#previous();
    const json = this.#expectWord("JSON");
    let encoding: "UTF8" | "UTF16" | "UTF32" | undefined;
    let end = json;
    if (this.#matchWord("ENCODING")) {
      const token = this.#current();
      const normalized = token.value.toUpperCase();
      if (!this.#isIdentifierLike(token) || !["UTF8", "UTF16", "UTF32"].includes(normalized)) {
        throw this.#error(`Unsupported JSON encoding ${token.text || "end of query"}`, token.range);
      }
      this.#advance();
      encoding = normalized as typeof encoding;
      end = token;
    }
    return {
      ...(encoding === undefined ? {} : { encoding }),
      range: mergeRanges(formatStart.range, end.range),
    };
  }

  #isJsonQueryBehaviorStart(): boolean {
    return ["DEFAULT", "ERROR", "NULL", "EMPTY"].some((word) => this.#isWord(this.#current(), word));
  }

  #isJsonQueryClauseStart(): boolean {
    if (
      ["FORMAT", "KEEP", "OMIT", "DEFAULT", "ERROR", "NULL", "EMPTY"].some((word) =>
        this.#isWord(this.#current(), word),
      )
    ) {
      return true;
    }
    if (this.#isWord(this.#current(), "WITHOUT")) {
      return this.#isWord(this.#peekToken(1), "ARRAY") || this.#isWord(this.#peekToken(1), "WRAPPER");
    }
    if (!this.#isWord(this.#current(), "WITH")) return false;
    return ["CONDITIONAL", "UNCONDITIONAL", "ARRAY", "WRAPPER"].some((word) => this.#isWord(this.#peekToken(1), word));
  }

  #parseJsonBehaviorClause(): { readonly behavior: JsonBehavior; readonly target: "empty" | "error" } {
    const start = this.#current();
    let behavior: JsonBehavior;
    if (this.#matchKeyword("DEFAULT")) {
      const expression = this.#parseExpression();
      behavior = { kind: "default", expression, range: mergeRanges(start.range, expression.range) };
    } else if (this.#matchWord("ERROR")) {
      behavior = { kind: "error", range: start.range };
    } else if (this.#matchKeyword("NULL")) {
      behavior = { kind: "null", range: start.range };
    } else {
      this.#expectWord("EMPTY");
      const object = this.#matchWord("OBJECT");
      if (!object) this.#matchKeyword("ARRAY");
      behavior = {
        kind: object ? "empty-object" : "empty-array",
        range: mergeRanges(start.range, this.#previous().range),
      };
    }
    this.#expectKeyword("ON");
    if (this.#matchWord("EMPTY")) return { behavior, target: "empty" };
    this.#expectWord("ERROR");
    return { behavior, target: "error" };
  }

  #parseCall(schema: Identifier | undefined, name: Identifier): Expression {
    const distinct = this.#matchKeyword("DISTINCT");
    const args: Expression[] = [];
    const argumentNames: (Identifier | undefined)[] = [];
    let named = false;
    let variadic = false;
    let orderBy: OrderByItem[] = [];
    let close: Token;
    if (this.#matchPunctuation(")")) close = this.#previous();
    else {
      do {
        if (variadic) throw this.#error("VARIADIC must be the final function argument", this.#current().range);
        if (this.#matchKeyword("VARIADIC")) {
          if (named) throw this.#error("VARIADIC cannot follow a named function argument", this.#previous().range);
          variadic = true;
          argumentNames.push(undefined);
          args.push(this.#parseExpression());
        } else if (
          this.#isIdentifierLike(this.#current()) &&
          this.#peekToken(1).kind === "operator" &&
          (this.#peekToken(1).value === "=>" || this.#peekToken(1).value === ":=")
        ) {
          const argumentName = this.#parseIdentifier(true);
          this.#advance();
          named = true;
          argumentNames.push(argumentName);
          args.push(this.#parseExpression());
        } else {
          if (named) {
            throw this.#error("Positional arguments cannot follow named function arguments", this.#current().range);
          }
          argumentNames.push(undefined);
          args.push(this.#parseExpression());
        }
        if (!this.#matchPunctuation(",")) break;
      } while (this.#current().value !== "ORDER");
      if (this.#matchKeyword("ORDER")) {
        this.#expectKeyword("BY");
        orderBy = this.#parseOrderByList();
      }
      close = this.#expectPunctuation(")");
    }
    let withinGroup: OrderByItem[] = [];
    if (this.#matchKeyword("WITHIN")) {
      this.#expectKeyword("GROUP");
      this.#expectPunctuation("(");
      this.#expectKeyword("ORDER");
      this.#expectKeyword("BY");
      withinGroup = this.#parseOrderByList();
      close = this.#expectPunctuation(")");
    }
    let filter: Expression | undefined;
    if (this.#syntax !== "mysql" && this.#matchKeyword("FILTER")) {
      this.#expectPunctuation("(");
      this.#expectKeyword("WHERE");
      filter = this.#parseExpression();
      close = this.#expectPunctuation(")");
    }
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
      ...(named ? { argumentNames } : {}),
      ...(variadic ? { variadic: true as const } : {}),
      distinct,
      ...(orderBy.length === 0 ? {} : { orderBy }),
      ...(withinGroup.length === 0 ? {} : { withinGroup }),
      ...(filter === undefined ? {} : { filter }),
      ...(over === undefined ? {} : { over }),
      range: mergeRanges(schema?.range ?? name.range, close.range),
    };
  }

  #parseWindowSpecification(): WindowSpecification {
    const start = this.#expectPunctuation("(").range;
    const base =
      this.#current().kind === "identifier" || this.#current().kind === "quoted-identifier"
        ? this.#parseIdentifier()
        : undefined;
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
    let frame: WindowSpecification["frame"];
    if (["ROWS", "RANGE", "GROUPS"].includes(this.#current().value)) {
      const frameStart = this.#advance();
      const unit = frameStart.value.toLowerCase() as NonNullable<WindowSpecification["frame"]>["unit"];
      let frameBound: WindowFrameBound;
      let end: WindowFrameBound | undefined;
      if (this.#matchKeyword("BETWEEN")) {
        frameBound = this.#parseWindowFrameBound();
        this.#expectKeyword("AND");
        end = this.#parseWindowFrameBound();
      } else frameBound = this.#parseWindowFrameBound();
      let exclusion: NonNullable<WindowSpecification["frame"]>["exclusion"];
      if (this.#matchKeyword("EXCLUDE")) {
        if (this.#matchKeyword("CURRENT")) {
          this.#expectKeyword("ROW");
          exclusion = "current-row";
        } else if (this.#matchKeyword("GROUP")) exclusion = "group";
        else if (this.#matchKeyword("TIES")) exclusion = "ties";
        else {
          this.#expectKeyword("NO");
          this.#expectKeyword("OTHERS");
          exclusion = "no-others";
        }
      }
      frame = {
        unit,
        start: frameBound,
        ...(end === undefined ? {} : { end }),
        ...(exclusion === undefined ? {} : { exclusion }),
        range: mergeRanges(frameStart.range, this.#previous().range),
      };
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

  #parseWindowFrameBound(): WindowFrameBound {
    const start = this.#current().range;
    if (this.#matchKeyword("UNBOUNDED")) {
      if (this.#matchKeyword("PRECEDING"))
        return { kind: "unbounded-preceding", range: mergeRanges(start, this.#previous().range) };
      this.#expectKeyword("FOLLOWING");
      return { kind: "unbounded-following", range: mergeRanges(start, this.#previous().range) };
    }
    if (this.#matchKeyword("CURRENT")) {
      const end = this.#expectKeyword("ROW").range;
      return { kind: "current-row", range: mergeRanges(start, end) };
    }
    const expression = this.#parseExpression();
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

  #isIntervalLiteralStart(): boolean {
    if (this.#current().value !== "INTERVAL") return false;
    if (this.#peekToken(1).kind === "string") return true;
    return (
      this.#peekToken(1).value === "(" &&
      this.#peekToken(2).kind === "number" &&
      this.#peekToken(3).value === ")" &&
      this.#peekToken(4).kind === "string"
    );
  }

  #parseIntervalLiteral(): Expression {
    const start = this.#advance();
    let typeEnd = start;
    let typeName = start.text;
    let prefixPrecision = false;
    if (this.#current().value === "(") {
      const precision = this.#parseIntervalPrecision();
      typeEnd = precision.end;
      typeName += this.#source.slice(precision.start.range.start, precision.end.range.end);
      prefixPrecision = true;
    }
    const value = this.#expect("string", "interval string literal");
    let end = value;
    if (prefixPrecision && intervalFields.has(this.#current().value)) {
      throw this.#error("Interval fields cannot follow prefix precision", this.#current().range);
    }
    if (!prefixPrecision && intervalFields.has(this.#current().value)) {
      const qualifier = this.#parseIntervalFields();
      typeEnd = qualifier.end;
      typeName += ` ${qualifier.text}`;
      end = qualifier.end;
      if (this.#current().value === "(") {
        if (qualifier.endField !== "SECOND") {
          throw this.#error("Interval precision requires SECOND as the least significant field", this.#current().range);
        }
        const precision = this.#parseIntervalPrecision();
        typeEnd = precision.end;
        typeName += this.#source.slice(precision.start.range.start, precision.end.range.end);
        end = precision.end;
      }
    }
    return {
      kind: "cast",
      expression: { kind: "literal", value: value.value, range: value.range },
      databaseType: { name: typeName, range: mergeRanges(start.range, typeEnd.range) },
      syntax: "typed-literal",
      range: mergeRanges(start.range, end.range),
    };
  }

  #parseSimpleTypedLiteral(): Expression {
    const type = this.#advance();
    const value = this.#expect("string", `${type.value.toLowerCase()} string literal`);
    return {
      kind: "cast",
      expression: { kind: "literal", value: value.value, range: value.range },
      databaseType: { name: type.text, range: type.range },
      syntax: "typed-literal",
      range: mergeRanges(type.range, value.range),
    };
  }

  #parseIntervalFields(): { readonly text: string; readonly end: Token; readonly endField: string } {
    const start = this.#current();
    if (!intervalFields.has(start.value)) {
      throw this.#error(`Expected interval field, found ${start.text || "end of query"}`, start.range);
    }
    this.#advance();
    let end = start;
    let endField = start.value;
    if (this.#matchWord("TO")) {
      const target = this.#current();
      if (!intervalFieldRanges.get(start.value)?.has(target.value)) {
        throw this.#error(`Invalid interval field range ${start.value} TO ${target.value}`, target.range);
      }
      end = this.#advance();
      endField = end.value;
    }
    return {
      text: this.#source.slice(start.range.start, end.range.end),
      end,
      endField,
    };
  }

  #parseIntervalPrecision(): { readonly start: Token; readonly end: Token } {
    const start = this.#expectPunctuation("(");
    const precision = this.#expect("number", "interval precision");
    if (!/^\d+$/u.test(precision.value)) {
      throw this.#error("Interval precision must be a non-negative integer", precision.range);
    }
    return { start, end: this.#expectPunctuation(")") };
  }

  #parseTypeName(stopAtClose: boolean, stopBefore?: () => boolean): TypeName {
    const start = this.#current();
    if (!this.#isIdentifierLike(start))
      throw this.#error(`Expected identifier, found ${start.text || "end of query"}`, start.range);
    this.#advance();
    let end = start;
    let schemaSeparatorAllowed = true;
    if (start.value === "INTERVAL" && this.#current().value !== ".") {
      let prefixPrecision = false;
      if (this.#current().value === "(") {
        end = this.#parseIntervalPrecision().end;
        prefixPrecision = true;
      }
      if (prefixPrecision && intervalFields.has(this.#current().value)) {
        throw this.#error("Interval fields cannot follow prefix precision", this.#current().range);
      }
      if (!prefixPrecision && intervalFields.has(this.#current().value)) {
        const qualifier = this.#parseIntervalFields();
        end = qualifier.end;
        if (this.#current().value === "(") {
          if (qualifier.endField !== "SECOND") {
            throw this.#error(
              "Interval precision requires SECOND as the least significant field",
              this.#current().range,
            );
          }
          end = this.#parseIntervalPrecision().end;
        }
      }
      while (this.#matchPunctuation("[")) end = this.#expectPunctuation("]");
      if (stopAtClose && this.#current().value !== ")") {
        throw this.#error(`Expected ) after type name, found ${this.#current().text}`, this.#current().range);
      }
      return {
        name: this.#source.slice(start.range.start, end.range.end).trim(),
        range: mergeRanges(start.range, end.range),
      };
    }
    while (true) {
      if (stopBefore?.() === true) break;
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

  #parseQualifiedIdentifier(): { readonly parts: readonly Identifier[]; readonly range: SourceRange } {
    const first = this.#parseIdentifier(true);
    const parts = [first];
    if (this.#matchPunctuation(".")) parts.push(this.#parseIdentifier(true));
    return { parts, range: mergeRanges(first.range, parts.at(-1)!.range) };
  }

  #isIdentifierLike(token: Token): boolean {
    return token.kind === "identifier" || token.kind === "quoted-identifier" || token.kind === "keyword";
  }

  #isStatementStart(): boolean {
    return ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "WITH"].includes(this.#current().value);
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

  #matchWord(word: string): boolean {
    if (this.#isWord(this.#current(), word)) {
      this.#advance();
      return true;
    }
    return false;
  }

  #isWord(token: Token, word: string): boolean {
    return token.kind !== "quoted-identifier" && this.#isIdentifierLike(token) && token.value.toUpperCase() === word;
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

  #expectWord(word: string): Token {
    const token = this.#current();
    if (!this.#matchWord(word))
      throw this.#error(`Expected ${word}, found ${token.text || "end of query"}`, token.range);
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
