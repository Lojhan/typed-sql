export type SqlDialect = string;
export const SCHEMA_FORMAT_VERSION = 1 as const;

export interface SchemaSnapshot {
  readonly formatVersion?: typeof SCHEMA_FORMAT_VERSION;
  readonly dialect: SqlDialect;
  readonly dialectVersion?: string;
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

export type TypePolicy = Readonly<Record<string, unknown>>;

export interface SchemaInput {
  readonly url?: string;
  readonly snapshot?: string;
  readonly migrations?: string;
}

export interface SchemaProvider {
  introspect(input: SchemaInput): Promise<SchemaSnapshot>;
}
