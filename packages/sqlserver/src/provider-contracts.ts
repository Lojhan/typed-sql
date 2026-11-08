import type { SqlServerTypePolicy } from "./type-policy.js";

export interface SqlServerQueryable {
  all<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<readonly Row[]>;
}
export interface SqlServerSchemaProviderOptions {
  readonly client?: SqlServerQueryable;
  readonly includeSchemas?: readonly string[];
  readonly typePolicy?: SqlServerTypePolicy;
}
