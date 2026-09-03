import type { SchemaSnapshotV1 } from "./v1/model.js";
import type { SchemaSnapshotV2 } from "./v2/model.js";

export type SqlDialect = string;
export type SchemaSnapshot = SchemaSnapshotV1 | SchemaSnapshotV2;

export interface GeneratedSchemaMetadata {
  readonly generatorVersion: string;
  readonly schemaHash: string;
  readonly typePolicyHash: string;
  readonly schemaFormat?: 1 | 2;
}

export type GeneratedSchemaSnapshot = SchemaSnapshot & { readonly metadata: GeneratedSchemaMetadata };
export type TypePolicy = Readonly<Record<string, unknown>>;

export interface SchemaInput {
  readonly url?: string;
  readonly snapshot?: string;
  readonly migrations?: string;
}

export interface SchemaProvider<Snapshot extends SchemaSnapshot = SchemaSnapshot> {
  introspect(input: SchemaInput): Promise<Snapshot>;
}

export type { DialectServerEvidence } from "@typed-sql/core";
export type {
  ColumnSnapshot,
  DomainSnapshot,
  FunctionSnapshot,
  SchemaSnapshotV1,
  TableSnapshot,
} from "./v1/model.js";
export { LEGACY_SCHEMA_FORMAT_VERSION } from "./v1/model.js";
export type {
  CheckConstraintSnapshot,
  CollectionTypeSnapshot,
  ColumnClassification,
  ColumnDefault,
  ColumnSnapshotV2,
  CompositeTypeFieldSnapshot,
  CompositeTypeSnapshot,
  ConstraintDeferrability,
  ConstraintSnapshot,
  DialectExtensionArray,
  DialectExtensionObject,
  DialectExtensionSnapshot,
  DialectExtensionValue,
  DomainTypeSnapshot,
  Eligibility,
  EnumTypeSnapshot,
  ExclusionConstraintElementSnapshot,
  ExclusionConstraintSnapshot,
  ForeignKeyAction,
  ForeignKeyConstraintSnapshot,
  GeneratedColumnKind,
  IdentityColumnKind,
  IndexColumnSnapshot,
  IndexSnapshot,
  NamespaceSnapshot,
  NullabilitySource,
  OpaqueTypeSnapshot,
  PrimaryKeyConstraintSnapshot,
  RangeTypeSnapshot,
  RelationSnapshot,
  RoutineArgumentMode,
  RoutineArgumentSnapshot,
  RoutineResultSnapshot,
  RoutineSnapshot,
  ScalarTypeSnapshot,
  SchemaSnapshotV2,
  SchemaSnapshotV2Envelope,
  TypeSnapshot,
  UniqueConstraintSnapshot,
} from "./v2/model.js";
export { SCHEMA_FORMAT_VERSION } from "./v2/model.js";
