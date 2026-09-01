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

export interface QualifiedIdentifier {
  readonly parts: readonly Identifier[];
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

export interface SubscriptExpression {
  readonly kind: "subscript";
  readonly expression: Expression;
  readonly index?: Expression;
  readonly lower?: Expression;
  readonly upper?: Expression;
  readonly slice: boolean;
  readonly range: SourceRange;
}

export interface CallExpression {
  readonly kind: "call";
  readonly name: Identifier;
  readonly schema?: Identifier;
  readonly arguments: readonly Expression[];
  readonly argumentNames?: readonly (Identifier | undefined)[];
  readonly variadic?: true;
  readonly distinct: boolean;
  readonly orderBy?: readonly OrderByItem[];
  readonly withinGroup?: readonly OrderByItem[];
  readonly filter?: Expression;
  readonly over?: Identifier | WindowSpecification;
  readonly range: SourceRange;
}

export interface CastExpression {
  readonly kind: "cast";
  readonly expression: Expression;
  readonly databaseType: TypeName;
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
  | ParameterExpression
  | ArrayExpression
  | RowExpression
  | SubscriptExpression
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
  readonly alias?: Identifier;
  readonly lateral: boolean;
  readonly only?: true;
  readonly includeDescendants?: true;
  readonly sample?: TableSampleClause;
  readonly range: SourceRange;
}

export interface SubqueryTableReference {
  readonly kind: "subquery";
  readonly query: SelectStatement;
  readonly alias?: Identifier;
  readonly columns: readonly Identifier[];
  readonly lateral: boolean;
  readonly name?: never;
  readonly schema?: never;
  readonly range: SourceRange;
}

export interface TableFunctionColumn {
  readonly name: Identifier;
  readonly databaseType?: TypeName;
  readonly range: SourceRange;
}

export interface TableFunctionItem {
  readonly call: CallExpression;
  readonly columns: readonly TableFunctionColumn[];
  readonly range: SourceRange;
}

export interface FunctionTableReference {
  readonly kind: "function";
  readonly rowsFrom?: true;
  readonly functions: readonly TableFunctionItem[];
  readonly withOrdinality: boolean;
  readonly alias?: Identifier;
  readonly columns: readonly TableFunctionColumn[];
  readonly lateral: boolean;
  readonly name?: never;
  readonly schema?: never;
  readonly range: SourceRange;
}

export interface TableSampleClause {
  readonly method: Identifier;
  readonly arguments: readonly Expression[];
  readonly repeatable?: Expression;
  readonly range: SourceRange;
}

export type TableReference = NamedTableReference | SubqueryTableReference | FunctionTableReference;

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
  readonly using?: string;
  readonly nulls?: "first" | "last";
  readonly range: SourceRange;
}

export type GroupingElement =
  | Expression
  | { readonly kind: "empty-group"; readonly range: SourceRange }
  | {
      readonly kind: "grouping-set" | "rollup" | "cube" | "grouping-sets";
      readonly elements: readonly GroupingElement[];
      readonly range: SourceRange;
    };

export type WindowFrameUnit = "rows" | "range" | "groups";
export type WindowFrameExclusion = "current-row" | "group" | "ties" | "no-others";

export type WindowFrameBound =
  | { readonly kind: "unbounded-preceding" | "unbounded-following" | "current-row"; readonly range: SourceRange }
  | {
      readonly kind: "preceding" | "following";
      readonly expression: Expression;
      readonly range: SourceRange;
    };

export interface WindowFrame {
  readonly unit: WindowFrameUnit;
  readonly start: WindowFrameBound;
  readonly end?: WindowFrameBound;
  readonly exclusion?: WindowFrameExclusion;
  readonly range: SourceRange;
}

export interface WindowSpecification {
  readonly base?: Identifier;
  readonly partitionBy: readonly Expression[];
  readonly orderBy: readonly OrderByItem[];
  readonly frame?: WindowFrame;
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
  readonly materialization?: "materialized" | "not-materialized";
  readonly search?: {
    readonly order: "breadth" | "depth";
    readonly by: readonly Identifier[];
    readonly set: Identifier;
    readonly range: SourceRange;
  };
  readonly cycle?: {
    readonly columns: readonly Identifier[];
    readonly set: Identifier;
    readonly markValue?: Expression;
    readonly markDefault?: Expression;
    readonly using: Identifier;
    readonly range: SourceRange;
  };
  readonly range: SourceRange;
}

export interface WithClause {
  readonly recursive: boolean;
  readonly queries: readonly CommonTableExpression[];
  readonly range: SourceRange;
}

export interface SelectLockingClause {
  readonly strength: "update" | "no-key-update" | "share" | "key-share";
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

export interface FetchClause {
  readonly count?: Expression;
  readonly withTies: boolean;
  readonly range: SourceRange;
}

export interface SelectStatement {
  readonly kind: "select";
  readonly with?: WithClause;
  readonly distinct: boolean;
  readonly distinctOn: readonly Expression[];
  readonly columns: readonly SelectItem[];
  readonly from?: TableReference;
  readonly joins: readonly JoinClause[];
  readonly where?: Expression;
  readonly groupModifier?: "all" | "distinct";
  readonly groupBy: readonly GroupingElement[];
  readonly having?: Expression;
  readonly windows: readonly NamedWindow[];
  readonly orderBy: readonly OrderByItem[];
  readonly limit?: Expression;
  readonly limitAll?: true;
  readonly offset?: Expression;
  readonly fetch?: FetchClause;
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

export interface InsertConflictElement {
  readonly expression: Expression;
  readonly collation?: QualifiedIdentifier;
  readonly operatorClass?: QualifiedIdentifier;
  readonly range: SourceRange;
}

export type InsertConflictTarget =
  | {
      readonly kind: "inference";
      readonly elements: readonly InsertConflictElement[];
      readonly predicate?: Expression;
      readonly range: SourceRange;
    }
  | { readonly kind: "constraint"; readonly constraint: Identifier; readonly range: SourceRange };

export type InsertConflictAction =
  | { readonly kind: "nothing"; readonly range: SourceRange }
  | {
      readonly kind: "update";
      readonly assignments: readonly UpdateAssignment[];
      readonly where?: Expression;
      readonly range: SourceRange;
    };

export interface InsertConflictClause {
  readonly target?: InsertConflictTarget;
  readonly action: InsertConflictAction;
  readonly range: SourceRange;
}

export interface ReturningAliases {
  readonly old?: Identifier;
  readonly new?: Identifier;
  readonly range: SourceRange;
}

export interface InsertStatement {
  readonly kind: "insert";
  readonly with?: WithClause;
  readonly table: NamedTableReference;
  readonly columns: readonly Identifier[];
  readonly overriding?: "system" | "user";
  readonly source: ValuesClause | DefaultValuesClause | SelectStatement;
  readonly conflict?: InsertConflictClause;
  readonly returningAliases?: ReturningAliases;
  readonly returning: readonly SelectItem[];
  readonly range: SourceRange;
}

export type UpdateAssignment =
  | {
      readonly column: Identifier;
      readonly value: Expression;
      readonly range: SourceRange;
    }
  | {
      readonly columns: readonly Identifier[];
      readonly value: Expression;
      readonly range: SourceRange;
    };

export interface CurrentOfClause {
  readonly cursor: Identifier;
  readonly range: SourceRange;
}

export interface UpdateStatement {
  readonly kind: "update";
  readonly with?: WithClause;
  readonly table: NamedTableReference;
  readonly assignments: readonly UpdateAssignment[];
  readonly from?: TableReference;
  readonly joins: readonly JoinClause[];
  readonly where?: Expression;
  readonly currentOf?: CurrentOfClause;
  readonly returningAliases?: ReturningAliases;
  readonly returning: readonly SelectItem[];
  readonly range: SourceRange;
}

export interface DeleteStatement {
  readonly kind: "delete";
  readonly with?: WithClause;
  readonly table: NamedTableReference;
  readonly using: readonly TableReference[];
  readonly joins: readonly JoinClause[];
  readonly where?: Expression;
  readonly currentOf?: CurrentOfClause;
  readonly returningAliases?: ReturningAliases;
  readonly returning: readonly SelectItem[];
  readonly range: SourceRange;
}

export interface MergeInsertAction {
  readonly kind: "insert";
  readonly columns: readonly Identifier[];
  readonly overriding?: "system" | "user";
  readonly source: ValuesClause | DefaultValuesClause;
  readonly range: SourceRange;
}

export interface MergeUpdateAction {
  readonly kind: "update";
  readonly assignments: readonly UpdateAssignment[];
  readonly range: SourceRange;
}

export type MergeAction =
  | MergeInsertAction
  | MergeUpdateAction
  | { readonly kind: "delete" | "nothing"; readonly range: SourceRange };

export interface MergeWhenClause {
  readonly match: "matched" | "not-matched-target" | "not-matched-source";
  readonly by?: "target" | "source";
  readonly condition?: Expression;
  readonly action: MergeAction;
  readonly range: SourceRange;
}

export interface MergeStatement {
  readonly kind: "merge";
  readonly with?: WithClause;
  readonly table: NamedTableReference;
  readonly source: TableReference | MergeValuesReference;
  readonly on: Expression;
  readonly clauses: readonly MergeWhenClause[];
  readonly returningAliases?: ReturningAliases;
  readonly returning: readonly SelectItem[];
  readonly range: SourceRange;
}

export interface MergeValuesReference {
  readonly kind: "values";
  readonly rows: readonly (readonly Expression[])[];
  readonly alias?: Identifier;
  readonly columns: readonly Identifier[];
  readonly range: SourceRange;
}

export type Statement = SelectStatement | InsertStatement | UpdateStatement | DeleteStatement | MergeStatement;

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
