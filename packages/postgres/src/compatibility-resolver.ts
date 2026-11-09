import type { SchemaSnapshot } from "@typed-sql/schema";
import { postgresCatalogProvider } from "./catalog/index.js";
import type { SelectStatement, Statement } from "./parser/index.js";
import { type ResolveOptions, resolveStatement as resolve } from "./resolver.js";
import { postgresTypeResolver } from "./type-resolution.js";

export { rowTypeLiteral } from "@typed-sql/core";
export type { ResolvedColumn, ResolvedQuery, ResolveOptions } from "./resolver.js";
export function resolveStatement(statement: Statement, schema: SchemaSnapshot, options: ResolveOptions = {}) {
  return resolve(statement, schema, options, postgresCatalogProvider, postgresTypeResolver);
}
export function resolveSelect(statement: SelectStatement, schema: SchemaSnapshot, options: ResolveOptions = {}) {
  return resolveStatement(statement, schema, options);
}
