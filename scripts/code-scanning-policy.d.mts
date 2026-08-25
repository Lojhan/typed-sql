export interface CodeScanningAlert {
  readonly number?: number;
  readonly rule?: {
    readonly id?: string;
    readonly security_severity_level?: string;
  };
  readonly most_recent_instance?: {
    readonly location?: {
      readonly path?: string;
    };
  };
}

export interface CodeScanningPolicyOptions {
  readonly repository?: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function blockingCodeScanningAlerts(alerts: readonly CodeScanningAlert[]): readonly CodeScanningAlert[];
export function fetchOpenCodeScanningAlerts(
  repository: string,
  options?: CodeScanningPolicyOptions,
): Promise<readonly CodeScanningAlert[]>;
export function assertCodeScanningPolicy(
  options?: CodeScanningPolicyOptions,
): Promise<{ readonly open: number; readonly blocking: 0 }>;
export function main(): Promise<void>;
