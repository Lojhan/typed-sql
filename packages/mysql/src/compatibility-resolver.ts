import type { SchemaSnapshot } from "@typed-sql/schema";
import { defaultMySqlCatalog } from "./catalog/index.js";
import type { Statement } from "./parser/index.js";
import { type ResolveMySqlOptions, resolveMySqlStatement as resolve } from "./resolver.js";

export type { ResolvedMySqlColumn, ResolvedMySqlQuery, ResolveMySqlOptions } from "./resolver.js";
export function resolveMySqlStatement(statement: Statement, schema: SchemaSnapshot, options: ResolveMySqlOptions = {}) {
  return resolve(statement, schema, options, defaultMySqlCatalog);
}
