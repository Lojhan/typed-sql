import type { SchemaSnapshot } from "@typed-sql/schema";
import { scopePostgresSchema } from "./catalog/index.js";
import type { PostgresExtensionManifest, PostgresExtensionQueryable } from "./extension-contracts.js";
import {
  introspectPostgresExtensionManifests as introspect,
  resolvePostgresExtensionManifests as resolve,
} from "./extensions-engine.js";

export type * from "./extension-contracts.js";
export {
  definePostgresExtensionManifest,
  POSTGRES_EXTENSION_MANIFEST_FORMAT_VERSION,
  PostgresExtensionResolutionError,
  postgresExtensionCasts,
  postgresExtensionOperators,
} from "./extensions-engine.js";
export function resolvePostgresExtensionManifests(
  source: SchemaSnapshot,
  manifests: readonly PostgresExtensionManifest[],
) {
  return resolve(scopePostgresSchema(source), manifests);
}
export function introspectPostgresExtensionManifests(
  source: SchemaSnapshot,
  manifests: readonly PostgresExtensionManifest[],
  client: PostgresExtensionQueryable,
) {
  return introspect(scopePostgresSchema(source), manifests, client);
}
