export interface NativeTypeDescriptor {
  nativeType?: string | null;
  engineType?: number | string;
  typeModifier?: number;
  nativeTypeStructure?: unknown;
  userTypeSchema?: string | null;
  userTypeName?: string | null;
  maxLength?: number | string;
  precision?: number | string;
  scale?: number | string;
}

export interface NativeDescription {
  columns?: readonly NativeTypeDescriptor[] | null;
  parameters?: readonly (NativeTypeDescriptor & { index: number })[];
  parameterCount?: number | null;
}

/** Stable codes identify rejections; details retain native messages for owner classification. */
export type NativePrepare = (
  sql: string,
) => Promise<{ accepted: boolean; reason?: string; detail?: string; metadata?: unknown }>;
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
