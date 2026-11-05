/** Grammar-owned worker protocol; no native pointers or driver imports enter the portable graph. */
export const ODBC_STATE = Object.freeze({
  phase: 0,
  epoch: 1,
  borrows: 2,
  cancel: 3,
  ack: 6,
  kind: 7,
  cancelFailure: 8,
  controlFailure: 9,
});
export const ODBC_PHASE = Object.freeze({ idle: 0, native: 1, drain: 2 });
export interface OdbcDiagnostic {
  readonly state: string;
  readonly native: number;
}
export interface OdbcFailure {
  readonly message: string;
  readonly stage: string;
  readonly diagnostics?: readonly OdbcDiagnostic[];
  readonly reusable: boolean;
}
export interface OdbcColumn {
  readonly name: string;
  readonly typeName: string;
  readonly type: number;
  readonly size: number;
  readonly scale: number;
  readonly nullable: boolean;
}
export type OdbcBoundValue = string | null | Uint8Array;
export type OdbcValue = OdbcBoundValue | number;
export function odbcValueBytes(value: OdbcValue): number {
  return typeof value === "number" ? 8 : typeof value === "string" ? value.length * 2 : (value?.byteLength ?? 0);
}
export interface OdbcResult {
  readonly rows: readonly (readonly OdbcValue[])[];
  readonly columns: readonly OdbcColumn[];
}
export interface OdbcWorkerOptions {
  readonly modulePath: string;
  readonly libraryPath: string;
  readonly connectionString: string;
  readonly shared: SharedArrayBuffer;
  readonly loginTimeoutSeconds: number;
  readonly queryTimeoutSeconds: number;
  readonly maximumCellBytes: number;
  readonly maximumResultBytes: number;
  readonly maximumRows: number;
  readonly chunkBytes: number;
}
export type OdbcCommand = { readonly id: number } & (
  | { readonly kind: "execute"; readonly text: string; readonly values: readonly OdbcBoundValue[] }
  | { readonly kind: "prepare"; readonly text: string }
  | { readonly kind: "preparedExecute"; readonly handle: number; readonly values: readonly OdbcBoundValue[] }
  | { readonly kind: "freePrepared"; readonly handle: number }
  | { readonly kind: "streamStart"; readonly text: string; readonly values: readonly OdbcBoundValue[] }
  | { readonly kind: "streamNext"; readonly handle: number; readonly batchSize: number }
  | { readonly kind: "streamClose"; readonly handle: number }
  | { readonly kind: "close" }
);
export interface OdbcReply {
  readonly id: number;
  readonly result?: OdbcResult;
  readonly handle?: number;
  readonly done?: boolean;
  readonly error?: OdbcFailure;
}
export function odbcState(shared: SharedArrayBuffer) {
  return { words: new Int32Array(shared), handle: new BigUint64Array(shared, 16, 1) };
}
export function odbcPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}
