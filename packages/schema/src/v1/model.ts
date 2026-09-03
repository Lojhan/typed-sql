import type { DialectServerEvidence } from "@typed-sql/core";

export const LEGACY_SCHEMA_FORMAT_VERSION = 1 as const;

export interface SchemaSnapshotV1 {
  readonly formatVersion: typeof LEGACY_SCHEMA_FORMAT_VERSION;
  readonly dialect: string;
  readonly dialectVersion?: string;
  readonly version?: string;
  /** Additive bridge introduced before the v2 envelope became writable. */
  readonly server?: DialectServerEvidence;
  readonly tables: Readonly<Record<string, TableSnapshot>>;
  readonly enums?: Readonly<Record<string, readonly string[]>>;
  readonly domains?: Readonly<Record<string, DomainSnapshot>>;
  readonly functions?: Readonly<Record<string, FunctionSnapshot>>;
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
  readonly volatility?: "immutable" | "stable" | "volatile";
}
