import type { SchemaSnapshotV2 } from "@typed-sql/schema";
import type { MySqlTypePolicy } from "./type-policy.js";

export interface MySqlQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
}

export interface MySqlQueryable {
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<MySqlQueryResult<Row>>;
}

export interface MySqlSchemaProviderOptions {
  readonly client?: MySqlQueryable;
  readonly includeSchemas?: readonly string[];
  readonly typePolicy?: MySqlTypePolicy;
}

export type MySqlIntrospectionCatalog = "schemas" | "columns" | "routines" | "parameters" | "constraints" | "indexes";

export interface MySqlIntrospectionDiagnostic {
  readonly code: "TSQ406";
  readonly severity: "warning";
  readonly catalog: MySqlIntrospectionCatalog;
  readonly message: string;
}

export interface MySqlIntrospectionResult {
  readonly snapshot: SchemaSnapshotV2;
  readonly diagnostics: readonly MySqlIntrospectionDiagnostic[];
}
