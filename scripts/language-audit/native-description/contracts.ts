export interface NativeTypeDescriptor {
  nativeType?: string | null;
  engineType?: number;
  typeModifier?: number;
  nativeTypeStructure?: unknown;
  userTypeSchema?: string | null;
  userTypeName?: string | null;
  maxLength?: number;
  precision?: number;
  scale?: number;
}

export interface NativeDescription {
  columns?: readonly NativeTypeDescriptor[] | null;
  parameters?: readonly (NativeTypeDescriptor & { index: number })[];
  parameterCount?: number | null;
}

export type NativePrepare = (sql: string) => Promise<{ accepted: boolean; reason?: string; metadata?: unknown }>;
export type DescriptionScope = "column" | "parameter";

/** Owners interpret driver evidence; they must not import the grammar under test. */
export interface NativeDescriptionMapper {
  id: string;
  claimSql(databaseType: string): string;
  identity(descriptor: NativeTypeDescriptor, scope: DescriptionScope): string | undefined;
}

export interface NativeTypeOracle {
  identity(descriptor: NativeTypeDescriptor, scope: DescriptionScope): string | undefined;
  resolve(databaseType: string): Promise<{ descriptor?: NativeTypeDescriptor; reason?: string }>;
}
