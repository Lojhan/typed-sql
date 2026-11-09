import type {
  ContractQualificationPolicy,
  ContractReconciliationContribution,
  NativeContractAdapter,
  QueryContractContext,
} from "../../packages/analysis/src/index.js";
import type { DialectAnalysis, DialectProfile, SchemaSnapshot } from "../../packages/core/src/index.js";

export interface NativeProjectFixture<Snapshot extends SchemaSnapshot, Policy> {
  readonly label: string;
  readonly fixtureProducer: string;
  readonly schema: Snapshot;
  readonly profile: DialectProfile<Snapshot, Policy>;
  readonly files: Readonly<Record<string, string>>;
  readonly analyze: (sql: string) => DialectAnalysis;
  readonly adapter: NativeContractAdapter & { inspectContext(): Promise<QueryContractContext> };
  readonly contribution: ContractReconciliationContribution;
  readonly policy: ContractQualificationPolicy;
  readonly scales?: readonly number[];
  readonly beforeOffline?: () => Promise<void>;
}
export interface NativeProjectObservation {
  readonly copies: number;
  readonly finiteCandidates: number;
  readonly admitted: number;
  readonly qualified: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly admittedSubsetComplete: boolean;
  readonly completeProject: boolean;
  readonly durable: { readonly bytes: number; readonly files: number };
  readonly cache: { readonly bytes: number; readonly files: number };
  readonly offlineReloadAndCheckMs: number;
}
export interface NativeProjectReport extends Readonly<Record<string, unknown>> {
  readonly label: string;
  readonly acquisitions: number;
  readonly inspections: number;
  readonly offlineNativeCalls: 0;
  readonly observations: readonly NativeProjectObservation[];
}
export declare function measureNativeProject<Snapshot extends SchemaSnapshot, Policy>(
  input: NativeProjectFixture<Snapshot, Policy>,
): Promise<NativeProjectReport>;
