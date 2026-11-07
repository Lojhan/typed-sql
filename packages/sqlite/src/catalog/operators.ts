import { operators as SQLITE_OPERATORS, unsupportedOperators } from "./generated/policy.js";
export type SqliteOperatorResult = "comparison" | "json-flexible" | "json-text" | "numeric" | "text";

export interface SqliteOperatorDefinition {
  readonly operator: string;
  readonly result: SqliteOperatorResult;
  readonly nullSafe?: boolean;
}

export { operators as SQLITE_OPERATORS } from "./generated/policy.js";
export const SQLITE_UNSUPPORTED_OPERATORS: ReadonlySet<string> = Object.freeze(new Set(unsupportedOperators));

export function sqliteOperator(operator: string): SqliteOperatorDefinition | undefined {
  return SQLITE_OPERATORS.find((definition) => definition.operator === operator);
}
