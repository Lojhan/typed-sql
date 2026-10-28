import type { DialectAnalysisContext } from "@typed-sql/core";
import type { Expression, Statement } from "./parser/types.js";

type RepeatedRanges = DialectAnalysisContext["repeatedFragmentRanges"];

function simpleInput(expression: Expression): boolean {
  return (
    expression.kind === "parameter" ||
    expression.kind === "literal" ||
    (expression.kind === "cast" && simpleInput(expression.expression))
  );
}

/** Certifies top-level input placements without walking projections or nested queries. */
export function hasStableRepeatedResult(sql: string, statement: Statement, ranges: RepeatedRanges): boolean {
  if (ranges === undefined || ranges.length === 0 || statement.with !== undefined) return false;
  const listEndsByStart = new Map<number, ReadonlySet<number>>();
  const pending: Expression[] =
    statement.kind === "select" && statement.compounds.length === 0 && statement.where !== undefined
      ? [statement.where]
      : [];
  while (pending.length > 0) {
    const expression = pending.pop()!;
    if (expression.kind === "binary" && ["AND", "OR"].includes(expression.operator.toUpperCase())) {
      pending.push(expression.left, expression.right);
    } else if (expression.kind === "unary" && expression.operator.toUpperCase() === "NOT") {
      pending.push(expression.expression);
    } else if (expression.kind === "in" && Array.isArray(expression.values) && expression.values.every(simpleInput)) {
      const ends = new Set(expression.values.map((item: Expression) => item.range.end));
      for (const item of expression.values) listEndsByStart.set(item.range.start, ends);
    }
  }
  const values =
    statement.kind === "insert" &&
    statement.source.kind === "values" &&
    statement.source.rows.length > 0 &&
    statement.source.rows.every((row) => row.every(simpleInput))
      ? statement.source.range
      : undefined;
  return ranges.every((range) => {
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 0 ||
      range.end > sql.length ||
      range.start >= range.end
    )
      return false;
    const text = sql.slice(range.start, range.end);
    const start = range.start + text.length - text.trimStart().length;
    const end = range.end - text.length + text.trimEnd().length;
    if (start >= end) return false;
    if (values !== undefined) return start >= values.start && end <= values.end;
    return listEndsByStart.get(start)?.has(end) === true;
  });
}
