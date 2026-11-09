import type {
  ContractQualificationPolicy,
  ContractReconciliationContribution,
  NativeContractAdapter,
  NativeContractCandidate,
  QueryContractContext,
} from "../../packages/analysis/src/index.js";
import type { DialectAnalysis, SchemaSnapshot } from "../../packages/core/src/index.js";

export interface NativeCostFixture {
  readonly label: string;
  readonly serverVersion: string;
  readonly schema: SchemaSnapshot;
  readonly adapter: NativeContractAdapter & { inspectContext(): Promise<QueryContractContext> };
  readonly candidate: NativeContractCandidate;
  readonly analyze: (sql: string) => DialectAnalysis;
  readonly contribution: ContractReconciliationContribution;
  readonly policy: ContractQualificationPolicy;
}

export declare function recordNativeCosts(input: NativeCostFixture): Promise<void>;
