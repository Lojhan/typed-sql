import type { PostgresExtensionManifest } from "./extension-contracts.js";
import type { PostgresTypePolicy } from "./policy.js";

export interface PostgresQueryResult<Row> {
  readonly rows: readonly Row[];
}

export interface PostgresQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresIntrospectionClient extends PostgresQueryable {
  release(): void;
}

export interface PostgresIntrospectionPool {
  connect(): Promise<PostgresIntrospectionClient>;
  end(): Promise<void>;
}

export interface PostgresDriverModule {
  readonly Pool: new (config: { readonly connectionString: string }) => PostgresIntrospectionPool;
}

export type PostgresDriverImporter = () => Promise<PostgresDriverModule>;

export interface PostgresSchemaProviderOptions {
  readonly client?: PostgresQueryable;
  readonly pool?: PostgresIntrospectionPool;
  readonly includeSchemas?: readonly string[];
  readonly typePolicy?: PostgresTypePolicy;
  readonly extensionManifests?: readonly PostgresExtensionManifest[];
}
