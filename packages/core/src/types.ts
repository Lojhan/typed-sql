export const DIALECT_CONTRACT_VERSION = 1 as const;

export interface SourceRange {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface SqlDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly range: SourceRange;
  readonly severity: "error" | "warning" | "info";
  readonly suggestion?: string;
}

export interface ColumnSnapshot {
  readonly name: string;
  readonly databaseType: string;
  readonly tsType: string;
  readonly nullable: boolean;
  readonly array?: boolean;
  readonly defaultExpression?: string;
}

export interface TableSnapshot {
  readonly schema?: string;
  readonly name: string;
  readonly columns: Readonly<Record<string, ColumnSnapshot>>;
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

export interface SchemaSnapshot {
  readonly formatVersion: 1;
  readonly dialect: string;
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

export interface ResolvedColumn {
  readonly name: string;
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
  readonly range: SourceRange;
}

export interface DialectAnalysis {
  readonly columns: readonly ResolvedColumn[];
  readonly diagnostics: readonly SqlDiagnostic[];
  readonly resultKind?: "rows" | "command";
}

export interface DialectPlugin<Snapshot extends SchemaSnapshot = SchemaSnapshot, Policy = unknown> {
  readonly contractVersion: typeof DIALECT_CONTRACT_VERSION;
  readonly id: string;
  readonly packageVersion: string;
  /** Exact package entrypoint from which applications import the dialect's `sql` tag. */
  readonly sqlModule: string;
  readonly defaultTypePolicy: Policy;
  placeholder(index: number): string;
  analyze(sql: string, snapshot: Snapshot, policy?: Policy): DialectAnalysis;
  validateSnapshot(value: unknown): Snapshot;
}

export interface SchemaProvider<Snapshot extends SchemaSnapshot = SchemaSnapshot> {
  introspect(): Promise<Snapshot>;
}

export interface TypedSqlConfig<Snapshot extends SchemaSnapshot = SchemaSnapshot, Policy = unknown> {
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly schema: {
    readonly file: string;
    readonly provider?: SchemaProvider<Snapshot>;
  };
  readonly outDir: string;
  readonly projects?: readonly string[];
  readonly typePolicy?: Policy;
}

export function defineConfig<Snapshot extends SchemaSnapshot, Policy>(
  config: TypedSqlConfig<Snapshot, Policy>,
): TypedSqlConfig<Snapshot, Policy> {
  if (config.dialect.contractVersion !== DIALECT_CONTRACT_VERSION) {
    throw new TypeError(`Unsupported typed-sql dialect contract ${config.dialect.contractVersion}`);
  }
  return Object.freeze(config);
}

export function rowTypeLiteral(columns: readonly ResolvedColumn[]): string {
  const properties = columns.map((column) => `${JSON.stringify(column.name)}: ${column.tsType}${column.nullable ? " | null" : ""};`);
  return `{ ${properties.join(" ")} }`;
}
