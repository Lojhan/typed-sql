import { postgresCatalogProvider } from "./catalog/index.js";
import { createPostgresTypeResolver } from "./type-resolution-factory.js";

export type {
  PostgresCandidate,
  PostgresCandidateMatch,
  PostgresCandidateResolution,
  PostgresOperatorResolution,
} from "./type-resolution-factory.js";
export const postgresTypeResolver = createPostgresTypeResolver(postgresCatalogProvider);
export const {
  postgresCanonicalType,
  postgresTypeCategory,
  postgresElementType,
  postgresCommonType,
  postgresCanCoerce,
  resolvePostgresCandidates,
  resolvePostgresUnaryOperator,
  resolvePostgresOperator,
} = postgresTypeResolver;
