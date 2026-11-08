import type { SchemaSnapshot } from "@typed-sql/schema";
import { nativeSignatures } from "./catalog/generated/native.js";
import { scopePostgresSchema } from "./catalog/index.js";
import type { SelectStatement, Statement } from "./parser/types.js";
import { type ResolveOptions, resolveStatement as resolve } from "./resolver-engine.js";

export { rowTypeLiteral } from "@typed-sql/core";
export type { ResolvedColumn, ResolvedQuery, ResolveOptions } from "./resolver-engine.js";
export function resolveStatement(statement: Statement, schema: SchemaSnapshot, options: ResolveOptions = {}) {
  return resolve(statement, scopePostgresSchema(schema), options, nativeSignatures);
}
export function resolveSelect(statement: SelectStatement, schema: SchemaSnapshot, options: ResolveOptions = {}) {
  return resolveStatement(statement, schema, options);
}
