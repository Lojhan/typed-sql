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

export interface TypeName {
  readonly name: string;
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
  readonly characterSet?: Identifier;
  readonly range: SourceRange;
}

export interface CollateExpression {
  readonly kind: "collate";
  readonly expression: Expression;
  readonly collation: Identifier;
  readonly range: SourceRange;
}

export interface ParameterExpression {
  readonly kind: "parameter";
  readonly index: number;
  readonly range: SourceRange;
}

export interface ArrayExpression {
  readonly kind: "array";
  readonly elements: readonly Expression[];
  readonly range: SourceRange;
}

export interface RowExpression {
  readonly kind: "row";
  readonly elements: readonly Expression[];
  readonly range: SourceRange;
}

export interface CallExpression {
  readonly kind: "call";
  readonly name: Identifier;
  readonly schema?: Identifier;
  readonly arguments: readonly Expression[];
  readonly distinct: boolean;
  readonly filter?: Expression;
  readonly over?: Identifier | WindowSpecification;
  readonly range: SourceRange;
}

export interface CastExpression {
  readonly kind: "cast";
  readonly expression: Expression;
  readonly databaseType: TypeName;
  readonly syntax: "cast";
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

export interface SubqueryExpression {
  readonly kind: "subquery";
  readonly query: SelectStatement;
  readonly range: SourceRange;
}

export interface ExistsExpression {
  readonly kind: "exists";
  readonly query: SelectStatement;
  readonly range: SourceRange;
}

export interface InExpression {
  readonly kind: "in";
  readonly expression: Expression;
  readonly values: readonly Expression[] | SelectStatement;
  readonly negated: boolean;
  readonly range: SourceRange;
}

export interface BetweenExpression {
  readonly kind: "between";
  readonly expression: Expression;
  readonly lower: Expression;
  readonly upper: Expression;
  readonly negated: boolean;
  readonly range: SourceRange;
}

export type Expression =
  | ColumnExpression
  | StarExpression
  | LiteralExpression
  | CollateExpression
  | ParameterExpression
  | ArrayExpression
  | RowExpression
  | CallExpression
  | CastExpression
  | BinaryExpression
  | UnaryExpression
  | CaseExpression
  | SubqueryExpression
  | ExistsExpression
  | InExpression
  | BetweenExpression;

export interface SelectItem {
  readonly expression: Expression;
  readonly alias?: Identifier;
  readonly range: SourceRange;
}

export interface NamedTableReference {
  readonly kind: "table";
  readonly name: Identifier;
  readonly schema?: Identifier;
  readonly partitions?: readonly Identifier[];
  readonly alias?: Identifier;
  readonly lateral: boolean;
  readonly range: SourceRange;
}

export interface SubqueryTableReference {
  readonly kind: "subquery";
  readonly query: SelectStatement;
  readonly alias: Identifier;
  readonly lateral: boolean;
  readonly name?: never;
  readonly schema?: never;
  readonly range: SourceRange;
}

export type TableReference = NamedTableReference | SubqueryTableReference;

export type JoinKind = "inner" | "left" | "right" | "full" | "cross";

export interface JoinClause {
  readonly kind: JoinKind;
  readonly table: TableReference;
  readonly on?: Expression;
  readonly using?: readonly Identifier[];
  readonly range: SourceRange;
}

export interface OrderByItem {
  readonly expression: Expression;
  readonly direction?: "asc" | "desc";
  readonly nulls?: "first" | "last";
  readonly range: SourceRange;
}

export interface WindowSpecification {
  readonly base?: Identifier;
  readonly partitionBy: readonly Expression[];
  readonly orderBy: readonly OrderByItem[];
  readonly frame?: WindowFrame;
  readonly range: SourceRange;
}

export type WindowFrameBoundary =
  | { readonly kind: "unbounded-preceding" | "current-row" | "unbounded-following"; readonly range: SourceRange }
  | { readonly kind: "preceding" | "following"; readonly expression: Expression; readonly range: SourceRange };

export interface WindowFrame {
  readonly unit: "rows" | "range";
  readonly start: WindowFrameBoundary;
  readonly end?: WindowFrameBoundary;
  readonly range: SourceRange;
}

export interface NamedWindow {
  readonly name: Identifier;
  readonly specification: WindowSpecification;
  readonly range: SourceRange;
}

export interface CommonTableExpression {
  readonly name: Identifier;
  readonly columns: readonly Identifier[];
  readonly statement: Statement;
  readonly range: SourceRange;
}

export interface WithClause {
  readonly recursive: boolean;
  readonly queries: readonly CommonTableExpression[];
  readonly range: SourceRange;
}

export interface SelectLockingClause {
  readonly strength: "update" | "share";
  readonly relations: readonly Identifier[];
  readonly wait?: "nowait" | "skip-locked";
  readonly range: SourceRange;
}

export interface CompoundSelect {
  readonly operator: "union" | "intersect" | "except";
  readonly all: boolean;
  readonly statement: SelectStatement;
  readonly range: SourceRange;
}

export interface SelectStatement {
  readonly kind: "select";
  readonly parenthesized?: true;
  readonly queryValues?: ValuesClause;
  readonly with?: WithClause;
  readonly distinct: boolean;
  readonly distinctOn: readonly Expression[];
  readonly columns: readonly SelectItem[];
  readonly from?: TableReference;
  readonly joins: readonly JoinClause[];
  readonly where?: Expression;
  readonly groupBy: readonly Expression[];
  readonly groupRollup?: true;
  readonly having?: Expression;
  readonly windows: readonly NamedWindow[];
  readonly orderBy: readonly OrderByItem[];
  readonly limit?: Expression;
  readonly offset?: Expression;
  readonly locking: readonly SelectLockingClause[];
  readonly compounds: readonly CompoundSelect[];
  readonly range: SourceRange;
}

export interface ValuesClause {
  readonly kind: "values";
  readonly rows: readonly (readonly Expression[])[];
  readonly range: SourceRange;
}

export interface DefaultValuesClause {
  readonly kind: "default-values";
  readonly range: SourceRange;
}

export type DmlPriority = "low" | "delayed" | "high";

export interface InsertSetClause {
  readonly kind: "set";
  readonly assignments: readonly UpdateAssignment[];
  readonly range: SourceRange;
}

export interface InsertStatement {
  readonly kind: "insert";
  readonly operation: "insert" | "replace";
  readonly with?: WithClause;
  readonly table: NamedTableReference;
  readonly priority?: DmlPriority;
  readonly ignore: boolean;
  readonly columnList: boolean;
  readonly columns: readonly Identifier[];
  readonly source: ValuesClause | DefaultValuesClause | InsertSetClause | SelectStatement;
  readonly rowAlias?: Identifier;
  readonly columnAliases: readonly Identifier[];
  readonly duplicateKey: readonly UpdateAssignment[];
  readonly returning: readonly SelectItem[];
  readonly range: SourceRange;
}

export interface UpdateAssignment {
  readonly column: ColumnExpression;
  readonly value: Expression;
  readonly range: SourceRange;
}

export interface UpdateStatement {
  readonly kind: "update";
  readonly with?: WithClause;
  readonly table: TableReference;
  readonly priority?: "low";
  readonly ignore: boolean;
  readonly assignments: readonly UpdateAssignment[];
  readonly joins: readonly JoinClause[];
  readonly where?: Expression;
  readonly orderBy: readonly OrderByItem[];
  readonly limit?: Expression;
  readonly returning: readonly SelectItem[];
  readonly range: SourceRange;
}

export interface DeleteStatement {
  readonly kind: "delete";
  readonly with?: WithClause;
  readonly table: TableReference;
  readonly targets: readonly Identifier[];
  readonly priority?: "low";
  readonly quick: boolean;
  readonly ignore: boolean;
  readonly multiTable: boolean;
  readonly joins: readonly JoinClause[];
  readonly where?: Expression;
  readonly orderBy: readonly OrderByItem[];
  readonly limit?: Expression;
  readonly returning: readonly SelectItem[];
  readonly range: SourceRange;
}

export type Statement = SelectStatement | InsertStatement | UpdateStatement | DeleteStatement;

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
