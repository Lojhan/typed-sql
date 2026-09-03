import { fingerprintSchemaExpression } from "@typed-sql/schema";
import { type Expression, parseSelect } from "./parser/index.js";

function structuralExpression(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structuralExpression);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "range")
      .map(([key, nested]) => [key, structuralExpression(nested)]),
  );
}

/** Stable grammar-owned identity used for expression comparison within one compiler run. */
export function postgresExpressionIdentity(expression: Expression): string {
  return JSON.stringify(structuralExpression(expression));
}

/** One-way snapshot identity for an already parsed PostgreSQL expression. */
export function fingerprintPostgresExpression(expression: Expression): string {
  return fingerprintSchemaExpression(postgresExpressionIdentity(expression));
}

/**
 * Parses server-deparsed SQL before hashing so whitespace and redundant parentheses do not make
 * equivalent index expressions produce different snapshot evidence.
 */
export function fingerprintPostgresExpressionSql(source: string): string {
  try {
    const item = parseSelect(`SELECT ${source} AS typed_sql_expression`).columns[0];
    return item === undefined ? fingerprintSchemaExpression(source) : fingerprintPostgresExpression(item.expression);
  } catch {
    return fingerprintSchemaExpression(source);
  }
}
