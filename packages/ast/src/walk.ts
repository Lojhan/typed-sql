import type { Expression, Identifier, Statement, TableReference, TypeName } from "./types.js";

export interface SqlAstContext {
  readonly ctes: readonly Identifier[];
}

export interface SqlAstVisitor {
  readonly statement?: (statement: Statement) => void;
  readonly table?: (table: TableReference, statement: Statement, context: SqlAstContext) => void;
  readonly expression?: (expression: Expression, statement: Statement) => void;
  readonly type?: (type: TypeName, statement: Statement) => void;
}

function walkExpression(
  expression: Expression,
  statement: Statement,
  visitor: SqlAstVisitor,
  context: SqlAstContext,
): void {
  visitor.expression?.(expression, statement);
  switch (expression.kind) {
    case "array":
    case "row":
      for (const element of expression.elements) walkExpression(element, statement, visitor, context);
      break;
    case "call":
      for (const argument of expression.arguments) walkExpression(argument, statement, visitor, context);
      if (expression.filter !== undefined) walkExpression(expression.filter, statement, visitor, context);
      if (expression.over !== undefined && "partitionBy" in expression.over) {
        for (const item of expression.over.partitionBy) walkExpression(item, statement, visitor, context);
        for (const item of expression.over.orderBy) walkExpression(item.expression, statement, visitor, context);
      }
      break;
    case "cast":
      walkExpression(expression.expression, statement, visitor, context);
      visitor.type?.(expression.databaseType, statement);
      break;
    case "binary":
      walkExpression(expression.left, statement, visitor, context);
      walkExpression(expression.right, statement, visitor, context);
      break;
    case "unary":
      walkExpression(expression.expression, statement, visitor, context);
      break;
    case "case":
      if (expression.operand !== undefined) walkExpression(expression.operand, statement, visitor, context);
      for (const branch of expression.branches) {
        walkExpression(branch.when, statement, visitor, context);
        walkExpression(branch.then, statement, visitor, context);
      }
      if (expression.elseExpression !== undefined)
        walkExpression(expression.elseExpression, statement, visitor, context);
      break;
    case "subquery":
    case "exists":
      walkStatementWithContext(expression.query, visitor, context.ctes);
      break;
    case "in":
      walkExpression(expression.expression, statement, visitor, context);
      if ("kind" in expression.values) walkStatementWithContext(expression.values, visitor, context.ctes);
      else for (const value of expression.values) walkExpression(value, statement, visitor, context);
      break;
    case "between":
      walkExpression(expression.expression, statement, visitor, context);
      walkExpression(expression.lower, statement, visitor, context);
      walkExpression(expression.upper, statement, visitor, context);
      break;
    case "column":
    case "star":
    case "literal":
    case "parameter":
      break;
  }
}

function walkTable(table: TableReference, statement: Statement, visitor: SqlAstVisitor, context: SqlAstContext): void {
  visitor.table?.(table, statement, context);
  if (table.kind === "subquery") walkStatementWithContext(table.query, visitor, context.ctes);
}

function walkStatementWithContext(
  statement: Statement,
  visitor: SqlAstVisitor,
  inheritedCtes: readonly Identifier[],
): void {
  visitor.statement?.(statement);
  const localCtes = [...inheritedCtes];
  if (statement.with?.recursive) localCtes.push(...statement.with.queries.map((query) => query.name));
  for (const query of statement.with?.queries ?? []) {
    walkStatementWithContext(query.statement, visitor, localCtes);
    if (!statement.with?.recursive) localCtes.push(query.name);
  }
  const context = Object.freeze({ ctes: Object.freeze(localCtes) });
  if (statement.kind === "select") {
    if (statement.from !== undefined) walkTable(statement.from, statement, visitor, context);
    for (const join of statement.joins) {
      walkTable(join.table, statement, visitor, context);
      if (join.on !== undefined) walkExpression(join.on, statement, visitor, context);
    }
    for (const item of statement.columns) walkExpression(item.expression, statement, visitor, context);
    if (statement.where !== undefined) walkExpression(statement.where, statement, visitor, context);
    for (const expression of statement.groupBy) walkExpression(expression, statement, visitor, context);
    if (statement.having !== undefined) walkExpression(statement.having, statement, visitor, context);
    for (const expression of statement.distinctOn) walkExpression(expression, statement, visitor, context);
    for (const window of statement.windows) {
      for (const expression of window.specification.partitionBy)
        walkExpression(expression, statement, visitor, context);
      for (const item of window.specification.orderBy) walkExpression(item.expression, statement, visitor, context);
    }
    for (const item of statement.orderBy) walkExpression(item.expression, statement, visitor, context);
    if (statement.limit !== undefined) walkExpression(statement.limit, statement, visitor, context);
    if (statement.offset !== undefined) walkExpression(statement.offset, statement, visitor, context);
    return;
  }
  walkTable(statement.table, statement, visitor, context);
  if (statement.kind === "insert") {
    if (statement.source.kind === "values") {
      for (const row of statement.source.rows)
        for (const expression of row) walkExpression(expression, statement, visitor, context);
    } else if (statement.source.kind === "select") walkStatementWithContext(statement.source, visitor, context.ctes);
  } else if (statement.kind === "update") {
    for (const assignment of statement.assignments) walkExpression(assignment.value, statement, visitor, context);
    if (statement.from !== undefined) walkTable(statement.from, statement, visitor, context);
    for (const join of statement.joins) {
      walkTable(join.table, statement, visitor, context);
      if (join.on !== undefined) walkExpression(join.on, statement, visitor, context);
    }
    if (statement.where !== undefined) walkExpression(statement.where, statement, visitor, context);
  } else {
    for (const table of statement.using) walkTable(table, statement, visitor, context);
    if (statement.where !== undefined) walkExpression(statement.where, statement, visitor, context);
  }
  for (const item of statement.returning) walkExpression(item.expression, statement, visitor, context);
}

/** Walks syntax only. Dialect packages remain responsible for assigning semantics. */
export function walkStatement(statement: Statement, visitor: SqlAstVisitor): void {
  walkStatementWithContext(statement, visitor, []);
}
