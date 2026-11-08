import type { SchemaSnapshot } from "@typed-sql/schema";
import type { PostgresExtensionManifest } from "./extension-contracts.js";
import type { PostgresTypePolicy } from "./type-policy.js";
export type PostgresSchemaSnapshot = SchemaSnapshot & { readonly dialect: "postgres" };
export interface PostgresDialectOptions {
  readonly typePolicy?: PostgresTypePolicy;
  readonly versionPolicy?: import("./capabilities.js").PostgresVersionPolicy;
  readonly extensions?: readonly PostgresExtensionManifest[];
}
