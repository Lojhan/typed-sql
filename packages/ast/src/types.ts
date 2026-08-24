export interface SourceRange {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export type TokenKind =
  | "identifier"
  | "quoted-identifier"
  | "keyword"
  | "number"
  | "string"
  | "parameter"
  | "operator"
  | "punctuation"
  | "eof";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly value: string;
  readonly range: SourceRange;
}

export interface Identifier {
  readonly name: string;
  readonly quoted: boolean;
  readonly range: SourceRange;
}

export interface ColumnExpression {
  readonly kind: "column";
  readonly relation?: Identifier;
  readonly column: Identifier;
  readonly range: SourceRange;
}

export interface StarExpression {
  readonly kind: "star";
  readonly relation?: Identifier;
  readonly range: SourceRange;
}

export interface LiteralExpression {
  readonly kind: "literal";
  readonly value: string | number | boolean | null;
  readonly range: SourceRange;
}

export interface ParameterExpression {
  readonly kind: "parameter";
  readonly index: number;
  readonly range: SourceRange;
}

export interface CallExpression {
  readonly kind: "call";
  readonly name: Identifier;
  readonly arguments: readonly Expression[];
  readonly range: SourceRange;
}

export interface CastExpression {
  readonly kind: "cast";
  readonly expression: Expression;
  readonly databaseType: Identifier;
  readonly syntax: "cast" | "postgres";
  readonly range: SourceRange;
}

export interface BinaryExpression {
  readonly kind: "binary";
  readonly left: Expression;
  readonly operator: string;
  readonly right: Expression;
  readonly range: SourceRange;
}

export interface UnaryExpression {
  readonly kind: "unary";
  readonly operator: string;
  readonly expression: Expression;
  readonly range: SourceRange;
}

export interface CaseBranch {
  readonly when: Expression;
  readonly then: Expression;
  readonly range: SourceRange;
}

export interface CaseExpression {
  readonly kind: "case";
  readonly operand?: Expression;
  readonly branches: readonly CaseBranch[];
  readonly elseExpression?: Expression;
  readonly range: SourceRange;
}

export type Expression =
  | ColumnExpression
  | StarExpression
  | LiteralExpression
  | ParameterExpression
  | CallExpression
  | CastExpression
  | BinaryExpression
  | UnaryExpression
  | CaseExpression;

export interface SelectItem {
  readonly expression: Expression;
  readonly alias?: Identifier;
  readonly range: SourceRange;
}

export interface TableReference {
  readonly name: Identifier;
  readonly schema?: Identifier;
  readonly alias?: Identifier;
  readonly range: SourceRange;
}

export type JoinKind = "inner" | "left" | "right" | "full";

export interface JoinClause {
  readonly kind: JoinKind;
  readonly table: TableReference;
  readonly on: Expression;
  readonly range: SourceRange;
}

export interface OrderByItem {
  readonly expression: Expression;
  readonly direction?: "asc" | "desc";
  readonly range: SourceRange;
}

export interface SelectStatement {
  readonly kind: "select";
  readonly distinct: boolean;
  readonly columns: readonly SelectItem[];
  readonly from?: TableReference;
  readonly joins: readonly JoinClause[];
  readonly where?: Expression;
  readonly groupBy: readonly Expression[];
  readonly having?: Expression;
  readonly orderBy: readonly OrderByItem[];
  readonly limit?: Expression;
  readonly offset?: Expression;
  readonly range: SourceRange;
}

export interface SqlDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly range: SourceRange;
  readonly severity: "error" | "warning" | "info";
  readonly suggestion?: string;
}

export function mergeRanges(first: SourceRange, last: SourceRange): SourceRange {
  return {
    start: first.start,
    end: last.end,
    line: first.line,
    column: first.column,
  };
}
