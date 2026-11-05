import type { Expression, Select, Source, Statement } from "./types.js";
export interface SqlServerVisitor {
  readonly expression?: (expression: Expression) => void;
  readonly source?: (source: Source) => void;
  readonly statement?: (statement: Statement) => void;
}
export function walkExpression(expression: Expression, visitor: SqlServerVisitor): void {
  visitor.expression?.(expression);
  switch (expression.kind) {
    case "unary":
    case "isnull":
      walkExpression(expression.argument, visitor);
      break;
    case "binary":
      walkExpression(expression.left, visitor);
      walkExpression(expression.right, visitor);
      break;
    case "cast":
      walkExpression(expression.argument, visitor);
      if (expression.style) walkExpression(expression.style, visitor);
      break;
    case "call":
      for (const value of expression.arguments) walkExpression(value, visitor);
      if (expression.over) {
        for (const value of expression.over.partition) walkExpression(value, visitor);
        for (const order of expression.over.order) walkExpression(order.expression, visitor);
        for (const boundary of [expression.over.frame?.start, expression.over.frame?.end])
          if (boundary?.offset) walkExpression(boundary.offset, visitor);
      }
      for (const order of expression.withinGroup ?? []) walkExpression(order.expression, visitor);
      break;
    case "case":
      if (expression.operand) walkExpression(expression.operand, visitor);
      for (const arm of expression.arms) {
        walkExpression(arm.when, visitor);
        walkExpression(arm.then, visitor);
      }
      if (expression.otherwise) walkExpression(expression.otherwise, visitor);
      break;
    case "between":
      walkExpression(expression.argument, visitor);
      walkExpression(expression.lower, visitor);
      walkExpression(expression.upper, visitor);
      break;
    case "in":
      walkExpression(expression.argument, visitor);
      if (Array.isArray(expression.values)) {
        for (const value of expression.values) walkExpression(value, visitor);
      } else walkStatement(expression.values as Select, visitor);
      break;
    case "subquery":
    case "exists":
      walkStatement(expression.query, visitor);
      break;
  }
}
export function walkStatement(statement: Statement, visitor: SqlServerVisitor): void {
  visitor.statement?.(statement);
  for (const cte of statement.with) walkStatement(cte.query, visitor);
  const expr = (value: Expression | undefined) => {
    if (value) walkExpression(value, visitor);
  };
  const source = (value: Source | undefined) => {
    if (!value) return;
    visitor.source?.(value);
    if (value.kind === "derived") walkStatement(value.query, visitor);
    if (value.kind === "function") expr(value.call);
    if (value.kind === "table") expr(value.systemTime);
  };
  if ("top" in statement) expr(statement.top?.count);
  if (statement.kind === "select") {
    for (const projection of statement.projections) expr(projection.expression);
    source(statement.from);
    for (const join of statement.joins) {
      source(join.source);
      expr(join.on);
    }
    expr(statement.where);
    for (const group of statement.group) expr(group);
    expr(statement.having);
    for (const order of statement.order) expr(order.expression);
    expr(statement.offset);
    expr(statement.fetch);
    for (const compound of statement.compounds) walkStatement(compound.query, visitor);
  } else {
    if (statement.output) for (const projection of statement.output.projections) expr(projection.expression);
    if (statement.kind === "insert") {
      for (const row of statement.values) for (const value of row) expr(value);
      if (statement.query) walkStatement(statement.query, visitor);
    } else {
      source(statement.from);
      for (const join of statement.joins) {
        source(join.source);
        expr(join.on);
      }
      expr(statement.where);
      if (statement.kind === "update") for (const assignment of statement.assignments) expr(assignment.value);
    }
  }
}
