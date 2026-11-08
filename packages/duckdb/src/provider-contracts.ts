import type { DuckDBTypePolicy } from "./type-policy.js";

export interface DuckDBQueryable {
  all<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<readonly Row[]>;
}
export interface DuckDBSchemaProviderOptions {
  readonly client: DuckDBQueryable;
  readonly typePolicy?: DuckDBTypePolicy;
  readonly catalogs?: readonly string[];
  readonly schemas?: readonly string[];
}
