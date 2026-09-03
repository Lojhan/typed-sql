/** @deprecated Use a grammar package for SQL parsing. This compatibility parser is removed in typed-sql 3.0. */
export type { ParseOptions } from "./compat/parser.js";
/** @deprecated Use a grammar package for SQL parsing. This compatibility parser is removed in typed-sql 3.0. */
export { DEFAULT_MAX_PARSE_DEPTH, parseSelect, parseStatement, SqlParseError } from "./compat/parser.js";
/** @deprecated Use the profile-driven exports from `@typed-sql/ast/toolkit`. */
export type { TokenizeOptions } from "./compat/tokenizer.js";
/** @deprecated Use the profile-driven exports from `@typed-sql/ast/toolkit`. */
export { DEFAULT_MAX_SQL_LENGTH, DEFAULT_MAX_TOKENS, SqlTokenizeError, tokenize } from "./compat/tokenizer.js";
export type {
  ArrayExpression,
  BetweenExpression,
  BinaryExpression,
  CallExpression,
  CaseBranch,
  CaseExpression,
  CastExpression,
  ColumnExpression,
  CommonTableExpression,
  CompoundSelect,
  DefaultValuesClause,
  DeleteStatement,
  ExistsExpression,
  Expression,
  Identifier,
  InExpression,
  InsertStatement,
  JoinClause,
  JoinKind,
  LiteralExpression,
  NamedTableReference,
  NamedWindow,
  OrderByItem,
  ParameterExpression,
  RowExpression,
  SelectItem,
  SelectLockingClause,
  SelectStatement,
  SourceRange,
  SqlDiagnostic,
  StarExpression,
  Statement,
  SubqueryExpression,
  SubqueryTableReference,
  TableReference,
  Token,
  TokenKind,
  TypeName,
  UnaryExpression,
  UpdateAssignment,
  UpdateStatement,
  ValuesClause,
  WindowSpecification,
  WithClause,
} from "./compat/types.js";
/** @deprecated Use a grammar-owned walker or the generic `walkTree` toolkit primitive. */
export type { SqlAstContext, SqlAstVisitor } from "./compat/walk.js";
/** @deprecated Use a grammar-owned walker or the generic `walkTree` toolkit primitive. */
export { walkStatement } from "./compat/walk.js";
