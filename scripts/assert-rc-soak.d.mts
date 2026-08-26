export interface RcSoakValidationOptions {
  readonly series: string;
  readonly now?: Date;
}

export interface AssertRcSoakOptions {
  readonly workspace?: string;
  readonly reportPath?: string;
  readonly now?: Date;
}

export interface RcSoakSummary {
  readonly candidate: string;
  readonly releaseCommit: string;
  readonly minimumDays: number;
  readonly consumerCount: number;
  readonly blockerCount: number;
  readonly decision: "go";
}

export function validateRcSoakReport(value: unknown, options: RcSoakValidationOptions): RcSoakSummary;
export function assertRcSoak(options?: AssertRcSoakOptions): Promise<RcSoakSummary>;
export function main(): Promise<void>;
