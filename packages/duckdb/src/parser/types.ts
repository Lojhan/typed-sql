import type { SourceRange } from "@typed-sql/core";
export interface Token {
  readonly kind: "word" | "quoted" | "string" | "number" | "parameter" | "operator" | "eof";
  readonly text: string;
  readonly value: string;
  readonly range: SourceRange;
}
export interface Expression {
  readonly kind:
    | "literal"
    | "parameter"
    | "name"
    | "star"
    | "unary"
    | "binary"
    | "call"
    | "cast"
    | "case"
    | "list"
    | "struct"
    | "tuple"
    | "subquery"
    | "index"
    | "lambda";
  readonly range: SourceRange;
  readonly value?: string;
  readonly parameterRange?: SourceRange;
  readonly literalSource?: string;
  readonly names?: readonly string[];
  readonly args?: readonly Expression[];
  readonly left?: Expression;
  readonly right?: Expression;
  readonly nativeType?: string;
  readonly query?: Statement;
  readonly filter?: Expression;
  readonly window?: boolean;
  readonly context?: readonly Expression[];
  readonly windowName?: string;
  readonly distinct?: boolean;
  readonly argumentNames?: readonly (string | undefined)[];
}
export interface Projection {
  readonly expression: Expression;
  readonly alias?: string;
  readonly exclude?: readonly string[];
  readonly replace?: readonly Projection[];
}
export interface Relation {
  readonly range: SourceRange;
  readonly name?: readonly string[];
  readonly expression?: Expression;
  readonly query?: Statement;
  readonly alias?: string;
  readonly columns?: readonly string[];
  readonly join?: "inner" | "left" | "right" | "full" | "cross" | "semi" | "anti" | "asof" | "asof-left" | "positional";
  readonly condition?: Expression;
  readonly using?: readonly string[];
  readonly natural?: boolean;
  readonly lateral?: boolean;
  readonly ordinality?: boolean;
}
export interface CommonTable {
  readonly name: string;
  readonly columns?: readonly string[];
  readonly query: Statement;
  readonly recursive: boolean;
}
export interface Statement {
  readonly kind: "select" | "insert" | "update" | "delete" | "describe" | "summarize" | "create" | "merge";
  readonly range: SourceRange;
  readonly ctes: readonly CommonTable[];
  readonly projections: readonly Projection[];
  readonly relations: readonly Relation[];
  readonly where?: Expression;
  readonly group?: readonly Expression[];
  readonly groupAll?: boolean;
  readonly having?: Expression;
  readonly qualify?: Expression;
  readonly order?: readonly Expression[];
  readonly limit?: Expression;
  readonly offset?: Expression;
  readonly distinct?: boolean;
  readonly distinctOn?: readonly Expression[];
  readonly windows?: readonly {
    readonly name: string;
    readonly expressions: readonly Expression[];
    readonly base?: string;
  }[];
  readonly set?: {
    readonly operation: "UNION" | "INTERSECT" | "EXCEPT";
    readonly byName: boolean;
    readonly all: boolean;
    readonly right: Statement;
  };
  readonly target?: readonly string[];
  readonly targetAlias?: string;
  readonly conflictColumns?: readonly string[];
  readonly conflictAssignments?: readonly { readonly name: string; readonly value: Expression }[];
  readonly conflictWhere?: Expression;
  readonly columns?: readonly string[];
  readonly values?: readonly (readonly Expression[])[];
  readonly source?: Statement;
  readonly assignments?: readonly { readonly name: string; readonly value: Expression }[];
  readonly returning?: readonly Projection[];
  readonly byName?: boolean;
  readonly conflict?: boolean;
}

/** Child expressions in the current SQL scope; subqueries own independent binding scopes. */
export function duckDBExpressionChildren(expression: Expression): readonly Expression[] {
  return [
    ...(expression.left ? [expression.left] : []),
    ...(expression.right ? [expression.right] : []),
    ...(expression.args ?? []),
    ...(expression.filter ? [expression.filter] : []),
    ...(expression.context ?? []),
  ];
}
