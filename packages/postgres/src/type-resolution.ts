import type { SchemaSnapshot } from "@typed-sql/schema";
import { scopePostgresSchema } from "./catalog/index.js";
import type { PostgresCastContext } from "./catalog/types.js";
import type { PostgresCandidate, PostgresCandidateResolution } from "./type-resolution-engine.js";
import * as engine from "./type-resolution-engine.js";

export type {
  PostgresCandidate,
  PostgresCandidateMatch,
  PostgresCandidateResolution,
  PostgresOperatorResolution,
} from "./type-resolution-engine.js";
export function postgresCanonicalType(databaseType: string, schema?: SchemaSnapshot) {
  return engine.postgresCanonicalType(databaseType, scopePostgresSchema(schema));
}
export function postgresTypeCategory(databaseType: string, schema?: SchemaSnapshot) {
  return engine.postgresTypeCategory(databaseType, scopePostgresSchema(schema));
}
export function postgresElementType(databaseType: string, schema?: SchemaSnapshot) {
  return engine.postgresElementType(databaseType, scopePostgresSchema(schema));
}
export function postgresCommonType(databaseTypes: readonly (string | undefined)[], schema?: SchemaSnapshot) {
  return engine.postgresCommonType(databaseTypes, scopePostgresSchema(schema));
}
export function postgresCanCoerce(
  source: string,
  target: string,
  context: PostgresCastContext,
  schema?: SchemaSnapshot,
) {
  return engine.postgresCanCoerce(source, target, context, scopePostgresSchema(schema));
}
export function resolvePostgresUnaryOperator(operator: string, operand: string | undefined, schema?: SchemaSnapshot) {
  return engine.resolvePostgresUnaryOperator(operator, operand, scopePostgresSchema(schema));
}
export function resolvePostgresOperator(
  operator: string,
  left: string | undefined,
  right: string | undefined,
  schema?: SchemaSnapshot,
) {
  return engine.resolvePostgresOperator(operator, left, right, scopePostgresSchema(schema));
}
export function resolvePostgresCandidates<Value>(
  candidates: readonly PostgresCandidate<Value>[],
  actualTypes: readonly (string | undefined)[],
  schema?: SchemaSnapshot,
): PostgresCandidateResolution<Value> {
  return engine.resolvePostgresCandidates(candidates, actualTypes, scopePostgresSchema(schema));
}
