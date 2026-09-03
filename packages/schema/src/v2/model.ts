import type { DialectServerEvidence } from "@typed-sql/core";
import type { GeneratedSchemaMetadata } from "../model.js";
import type { DomainSnapshot, FunctionSnapshot, TableSnapshot } from "../v1/model.js";

export const SCHEMA_FORMAT_VERSION = 2 as const;

export interface DialectExtensionArray extends ReadonlyArray<DialectExtensionValue> {}
export interface DialectExtensionObject {
  readonly [key: string]: DialectExtensionValue;
}
export type DialectExtensionValue = string | number | boolean | null | DialectExtensionArray | DialectExtensionObject;

export interface DialectExtensionSnapshot {
  readonly version: string;
  readonly attributes: Readonly<Record<string, DialectExtensionValue>>;
}

export interface NamespaceSnapshot {
  readonly name: string;
  readonly kind: "catalog" | "database" | "schema";
  readonly extension?: DialectExtensionSnapshot;
}

export type NullabilitySource = "declared" | "domain" | "generated" | "inferred" | "unknown";
export type ColumnDefault = "none" | "present" | "unknown";
export type GeneratedColumnKind = "none" | "virtual" | "stored";
export type IdentityColumnKind = "none" | "always" | "by-default" | "unknown";
export type ColumnClassification = "normal" | "hidden" | "system" | "rowid";
export type Eligibility = boolean | "unknown";

export interface ColumnSnapshotV2 {
  readonly name: string;
  /** Zero-based declared relation-column order. */
  readonly position: number;
  readonly databaseType: string;
  /** Stable grammar-owned identity; neutral packages never interpret it. */
  readonly typeIdentity: string;
  readonly tsType: string;
  readonly nullable: boolean;
  readonly nullabilitySource: NullabilitySource;
  readonly default: ColumnDefault;
  readonly defaultExpressionHash?: string;
  readonly generated: GeneratedColumnKind;
  readonly generatedExpressionHash?: string;
  readonly identity: IdentityColumnKind;
  readonly collation?: string;
  readonly characterSet?: string;
  readonly dimensions?: readonly number[];
  readonly classification: ColumnClassification;
  readonly insertable: Eligibility;
  readonly updatable: Eligibility;
  readonly extension?: DialectExtensionSnapshot;
}

export type ConstraintDeferrability = boolean | "unknown";
export type ForeignKeyAction = "no-action" | "restrict" | "cascade" | "set-null" | "set-default" | "unknown";

interface NamedConstraintSnapshot {
  readonly name?: string;
  readonly identity: string;
  readonly columns: readonly string[];
  readonly partial: boolean | "unknown";
  readonly expressionBased: boolean | "unknown";
  readonly deferrable: ConstraintDeferrability;
  readonly initiallyDeferred: ConstraintDeferrability;
  readonly extension?: DialectExtensionSnapshot;
}

export interface PrimaryKeyConstraintSnapshot extends NamedConstraintSnapshot {
  readonly kind: "primary-key";
  readonly nullsDistinct: false;
}

export interface UniqueConstraintSnapshot extends NamedConstraintSnapshot {
  readonly kind: "unique";
  readonly nullsDistinct: boolean | "unknown";
}

export interface ForeignKeyConstraintSnapshot extends NamedConstraintSnapshot {
  readonly kind: "foreign-key";
  readonly referencedRelation: string;
  readonly referencedColumns: readonly string[];
  readonly match: "simple" | "full" | "partial" | "unknown";
  readonly onUpdate: ForeignKeyAction;
  readonly onDelete: ForeignKeyAction;
}

export interface CheckConstraintSnapshot extends NamedConstraintSnapshot {
  readonly kind: "check";
  readonly predicate: "present" | "unknown";
  readonly predicateHash?: string;
}

export interface ExclusionConstraintElementSnapshot {
  readonly column?: string;
  readonly expressionHash?: string;
  readonly operator: string;
  readonly operatorClass?: string;
  readonly collation?: string;
}

export interface ExclusionConstraintSnapshot extends NamedConstraintSnapshot {
  readonly kind: "exclusion";
  readonly elements: readonly ExclusionConstraintElementSnapshot[];
  readonly predicateHash?: string;
}

export type ConstraintSnapshot =
  | PrimaryKeyConstraintSnapshot
  | UniqueConstraintSnapshot
  | ForeignKeyConstraintSnapshot
  | CheckConstraintSnapshot
  | ExclusionConstraintSnapshot;

export interface IndexColumnSnapshot {
  readonly column?: string;
  readonly expressionHash?: string;
  readonly descending?: boolean;
  readonly nulls?: "first" | "last";
  readonly operatorClass?: string;
  readonly collation?: string;
}

export interface IndexSnapshot {
  readonly name: string;
  readonly identity: string;
  readonly unique: boolean;
  readonly method?: string;
  readonly columns: readonly IndexColumnSnapshot[];
  readonly includedColumns?: readonly string[];
  readonly predicate: "none" | "present" | "unknown";
  readonly predicateHash?: string;
  readonly valid: boolean | "unknown";
  readonly extension?: DialectExtensionSnapshot;
}

export interface RelationSnapshot {
  readonly schema?: string;
  readonly name: string;
  readonly kind: "table" | "view" | "materialized-view" | "foreign-table" | "virtual-table";
  readonly columns: Readonly<Record<string, ColumnSnapshotV2>>;
  readonly constraints: readonly ConstraintSnapshot[];
  readonly indexes: readonly IndexSnapshot[];
  readonly capabilities?: Readonly<Record<string, boolean | string | number>>;
  readonly extension?: DialectExtensionSnapshot;
}

interface BaseTypeSnapshot {
  readonly name: string;
  readonly schema?: string;
  readonly identity: string;
  readonly databaseType: string;
  readonly tsType: string;
  readonly extension?: DialectExtensionSnapshot;
}

export interface ScalarTypeSnapshot extends BaseTypeSnapshot {
  readonly kind: "scalar";
}

export interface EnumTypeSnapshot extends BaseTypeSnapshot {
  readonly kind: "enum";
  readonly labels: readonly string[];
}

export interface DomainTypeSnapshot extends BaseTypeSnapshot {
  readonly kind: "domain";
  readonly baseTypeIdentity: string;
  readonly nullable: boolean;
  readonly checks: readonly string[];
}

export interface CompositeTypeFieldSnapshot {
  readonly name: string;
  readonly typeIdentity: string;
  readonly databaseType: string;
  readonly tsType: string;
  readonly nullable: boolean;
}

export interface CompositeTypeSnapshot extends BaseTypeSnapshot {
  readonly kind: "composite";
  readonly fields: readonly CompositeTypeFieldSnapshot[];
}

export interface RangeTypeSnapshot extends BaseTypeSnapshot {
  readonly kind: "range" | "multirange";
  readonly subtypeIdentity: string;
}

export interface CollectionTypeSnapshot extends BaseTypeSnapshot {
  readonly kind: "collection";
  readonly elementTypeIdentity: string;
  readonly dimensions?: readonly number[];
}

export interface OpaqueTypeSnapshot extends BaseTypeSnapshot {
  readonly kind: "opaque";
  readonly reason: string;
}

export type TypeSnapshot =
  | ScalarTypeSnapshot
  | EnumTypeSnapshot
  | DomainTypeSnapshot
  | CompositeTypeSnapshot
  | RangeTypeSnapshot
  | CollectionTypeSnapshot
  | OpaqueTypeSnapshot;

export type RoutineArgumentMode = "in" | "out" | "inout" | "variadic";

export interface RoutineArgumentSnapshot {
  readonly name?: string;
  readonly mode: RoutineArgumentMode;
  readonly typeIdentity: string;
  readonly databaseType: string;
  readonly tsType: string;
  readonly default: "none" | "present" | "unknown";
}

export type RoutineResultSnapshot =
  | {
      readonly kind: "scalar" | "set";
      readonly typeIdentity: string;
      readonly databaseType: string;
      readonly tsType: string;
      readonly nullable: boolean;
    }
  | { readonly kind: "record"; readonly columns: Readonly<Record<string, ColumnSnapshotV2>> }
  | { readonly kind: "table"; readonly columns: Readonly<Record<string, ColumnSnapshotV2>> }
  | { readonly kind: "void" | "command" };

export interface RoutineSnapshot {
  readonly name: string;
  readonly schema?: string;
  readonly identity: string;
  readonly kind: "function" | "procedure" | "aggregate" | "window";
  readonly arguments: readonly RoutineArgumentSnapshot[];
  readonly result: RoutineResultSnapshot;
  readonly volatility: "immutable" | "stable" | "volatile" | "unknown";
  readonly deterministic: boolean | "unknown";
  readonly dataAccess: "none" | "contains-sql" | "reads-sql" | "modifies-sql" | "unknown";
  readonly nullInput: "strict" | "called" | "unknown";
  readonly availableSince?: string;
  readonly availableUntil?: string;
  readonly polymorphicFamily?: string;
  readonly extension?: DialectExtensionSnapshot;
}

export interface SchemaSnapshotV2 {
  readonly formatVersion: typeof SCHEMA_FORMAT_VERSION;
  readonly dialect: string;
  readonly dialectVersion: string;
  readonly server: DialectServerEvidence;
  readonly namespaces: Readonly<Record<string, NamespaceSnapshot>>;
  readonly types: Readonly<Record<string, TypeSnapshot>>;
  readonly relations: Readonly<Record<string, RelationSnapshot>>;
  readonly routines: Readonly<Record<string, readonly RoutineSnapshot[]>>;
  readonly metadata?: GeneratedSchemaMetadata;
  readonly extension?: DialectExtensionSnapshot;

  /** Transitional in-memory projections. Canonical v2 serialization omits these fields. */
  readonly version?: string;
  readonly tables: Readonly<Record<string, TableSnapshot>>;
  readonly enums?: Readonly<Record<string, readonly string[]>>;
  readonly domains?: Readonly<Record<string, DomainSnapshot>>;
  readonly functions?: Readonly<Record<string, FunctionSnapshot>>;
}

export type SchemaSnapshotV2Envelope = Omit<SchemaSnapshotV2, "version" | "tables" | "enums" | "domains" | "functions">;
