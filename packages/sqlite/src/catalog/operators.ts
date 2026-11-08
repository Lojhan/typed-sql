export type SqliteOperatorResult = "comparison" | "json-flexible" | "json-text" | "numeric" | "text";

export interface SqliteOperatorDefinition {
  readonly operator: string;
  readonly result: SqliteOperatorResult;
  readonly nullSafe?: boolean;
}

export const SQLITE_OPERATORS: readonly SqliteOperatorDefinition[] = Object.freeze([
  { operator: "=", result: "comparison" },
  { operator: "!=", result: "comparison" },
  { operator: "<>", result: "comparison" },
  { operator: "<", result: "comparison" },
  { operator: "<=", result: "comparison" },
  { operator: ">", result: "comparison" },
  { operator: ">=", result: "comparison" },
  { operator: "IS", result: "comparison", nullSafe: true },
  { operator: "IS NOT", result: "comparison", nullSafe: true },
  { operator: "IS DISTINCT FROM", result: "comparison", nullSafe: true },
  { operator: "IS NOT DISTINCT FROM", result: "comparison", nullSafe: true },
  { operator: "LIKE", result: "comparison" },
  { operator: "NOT LIKE", result: "comparison" },
  { operator: "AND", result: "comparison" },
  { operator: "OR", result: "comparison" },
  { operator: "||", result: "text" },
  { operator: "->", result: "json-text" },
  { operator: "->>", result: "json-flexible" },
  { operator: "+", result: "numeric" },
  { operator: "-", result: "numeric" },
  { operator: "*", result: "numeric" },
  { operator: "/", result: "numeric" },
  { operator: "%", result: "numeric" },
  { operator: "&", result: "numeric" },
  { operator: "|", result: "numeric" },
  { operator: "<<", result: "numeric" },
  { operator: ">>", result: "numeric" },
]);

export const SQLITE_UNSUPPORTED_OPERATORS = Object.freeze(
  new Set([
    "ILIKE",
    "NOT ILIKE",
    "SIMILAR TO",
    "NOT SIMILAR TO",
    "^",
    "~",
    "~*",
    "!~",
    "!~*",
    "#>",
    "#>>",
    "@>",
    "<@",
    "?",
    "?|",
    "?&",
    "&&",
  ]),
);

export function sqliteOperator(operator: string): SqliteOperatorDefinition | undefined {
  return SQLITE_OPERATORS.find((definition) => definition.operator === operator);
}
