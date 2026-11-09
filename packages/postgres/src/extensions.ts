import type { SchemaSnapshot } from "@typed-sql/schema";
import { postgresCatalogProvider } from "./catalog/index.js";
import {
  introspectPostgresExtensionManifests as introspect,
  type PostgresExtensionManifest,
  type PostgresExtensionQueryable,
  resolvePostgresExtensionManifests as resolve,
} from "./extension-resolution.js";

export * from "./extension-resolution.js";

export function resolvePostgresExtensionManifests(
  source: SchemaSnapshot,
  manifests: readonly PostgresExtensionManifest[],
) {
  return resolve(source, manifests, postgresCatalogProvider);
}

export function introspectPostgresExtensionManifests(
  source: SchemaSnapshot,
  manifests: readonly PostgresExtensionManifest[],
  client: PostgresExtensionQueryable,
) {
  return introspect(source, manifests, client, postgresCatalogProvider);
}
