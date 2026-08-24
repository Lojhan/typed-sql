export type SqlDialect = "postgres" | "mysql" | "sqlite";

export interface SchemaSnapshot {
  readonly dialect: SqlDialect;
  readonly version?: string;
  readonly tables: Readonly<Record<string, TableSnapshot>>;
  readonly enums?: Readonly<Record<string, readonly string[]>>;
  readonly domains?: Readonly<Record<string, DomainSnapshot>>;
  readonly functions?: Readonly<Record<string, FunctionSnapshot>>;
}

export interface GeneratedSchemaMetadata {
  readonly generatorVersion: string;
  readonly schemaHash: string;
  readonly typePolicyHash: string;
}

export interface GeneratedSchemaSnapshot extends SchemaSnapshot {
  readonly metadata: GeneratedSchemaMetadata;
}

export interface TableSnapshot {
  readonly schema?: string;
  readonly name: string;
  readonly columns: Readonly<Record<string, ColumnSnapshot>>;
}

export interface ColumnSnapshot {
  readonly name: string;
  readonly databaseType: string;
  readonly tsType: string;
  readonly nullable: boolean;
  readonly array?: boolean;
  readonly defaultExpression?: string;
}

export interface DomainSnapshot {
  readonly name: string;
  readonly databaseType: string;
  readonly tsType: string;
  readonly nullable: boolean;
}

export interface FunctionSnapshot {
  readonly name: string;
  readonly schema?: string;
  readonly argumentTypes: readonly string[];
  readonly databaseReturnType?: string;
  readonly returnType: string;
  readonly nullable: boolean;
  readonly setReturning?: boolean;
}

export interface TypePolicy {
  readonly bigint: "bigint" | "string" | "number";
  readonly numeric: "string" | "number" | "Decimal";
  readonly date: "Date" | "string";
  readonly json: "unknown" | "JsonValue" | "string";
  readonly enums: "string-union" | "string";
  readonly unknown: "unknown" | "never";
}

export interface SchemaInput {
  readonly url?: string;
  readonly snapshot?: string;
  readonly migrations?: string;
}

export interface SchemaProvider {
  introspect(input: SchemaInput): Promise<SchemaSnapshot>;
}

export const defaultPostgresTypePolicy: TypePolicy = {
  bigint: "bigint",
  numeric: "string",
  date: "Date",
  json: "unknown",
  enums: "string-union",
  unknown: "unknown",
};
