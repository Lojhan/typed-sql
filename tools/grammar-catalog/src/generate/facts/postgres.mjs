// Compatibility adapters for legacy callers; production emitters consume validated entities.

import { postgresEntityFacts } from "../../mappers/facets/postgres.mjs";
import { postgresMapper } from "../../mappers/postgres.mjs";
import { describeRoutine } from "../../model/build.mjs";
import { describeEntity } from "../../model/facets.mjs";
import { postgresSemanticCasts, postgresSemanticSignature, postgresSemanticTypes } from "./postgres-semantic.mjs";

const entities = (category, rows) =>
  rows.map((row) => ({
    name: row.name,
    semantic: describeEntity(category, row.name, postgresEntityFacts(category, row)),
  }));
export function postgresSignature(row) {
  return row.signature
    ? postgresSemanticSignature({ name: row.name, routine: describeRoutine(row.signature, postgresMapper) })
    : undefined;
}
export const postgresTypes = (rows, policies, categories) =>
  postgresSemanticTypes(entities("types", rows), policies, categories);
export const postgresCasts = (rows, types) => postgresSemanticCasts(entities("casts", rows), types);
