import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";
import type { NativeContractAdapter } from "./acquisition.js";
import { type AnalysisConfiguration, defineAnalysisConfiguration } from "./configuration.js";
import type { QueryContractContext } from "./contracts.js";
import type { LiveAnalysisFailure } from "./live.js";
import type { ContractReconciliationContribution } from "./reconciliation.js";

export interface LiveAnalysisServices {
  readonly connectionContext: string;
  readonly adapter: NativeContractAdapter;
  readonly contribution: ContractReconciliationContribution;
  inspectContext(signal: AbortSignal): Promise<QueryContractContext>;
  classifyError?(error: unknown): LiveAnalysisFailure;
  /** Cancels owned transport work and closes application-owned acquisition resources. */
  close(): Promise<void>;
}
export interface LiveAnalysisRegistration<Snapshot extends SchemaSnapshot = SchemaSnapshot, Policy = unknown> {
  readonly adapter: (input: {
    readonly schema: Snapshot;
    readonly typePolicy: Policy;
    readonly signal: AbortSignal;
  }) => LiveAnalysisServices | Promise<LiveAnalysisServices>;
  readonly deadlineMs?: number;
  readonly batchDeadlineMs?: number;
  readonly maxActive?: number;
  readonly concurrencyPerContext?: number;
}
export interface AnalysisRegistration<Snapshot extends SchemaSnapshot = SchemaSnapshot, Policy = unknown>
  extends AnalysisConfiguration {
  readonly live?: LiveAnalysisRegistration<Snapshot, Policy>;
}

/** Registers explicit factories without invoking them or serializing executable configuration. */
export function defineAnalysisRegistration<Snapshot extends SchemaSnapshot = SchemaSnapshot, Policy = unknown>(
  input: AnalysisRegistration<Snapshot, Policy>,
): AnalysisRegistration<Snapshot, Policy> & { readonly mode: "offline" | "frozen" | "live" } {
  const data = fields(input),
    live = data.live;
  delete data.live;
  const configuration = defineAnalysisConfiguration(data);
  if (live === undefined) return configuration;
  const registration = fields(live);
  if (
    Object.keys(registration).some(
      (key) => !["adapter", "deadlineMs", "batchDeadlineMs", "maxActive", "concurrencyPerContext"].includes(key),
    ) ||
    typeof registration.adapter !== "function"
  )
    throw new TypeError("Invalid live analysis registration");
  for (const [key, maximum] of [
    ["deadlineMs", 300_000],
    ["batchDeadlineMs", 3_600_000],
    ["maxActive", 64],
    ["concurrencyPerContext", 64],
  ] as const)
    if (
      registration[key] !== undefined &&
      (!Number.isSafeInteger(registration[key]) ||
        (registration[key] as number) < 1 ||
        (registration[key] as number) > maximum)
    )
      throw new TypeError(`Invalid live analysis ${key}`);
  return Object.freeze({
    ...configuration,
    live: Object.freeze(registration) as unknown as LiveAnalysisRegistration<Snapshot, Policy>,
  });
}
function fields(input: unknown): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.getOwnPropertySymbols(input).length
  )
    throw new TypeError("Analysis registration requires plain fields");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some((field) => !("value" in field)))
    throw new TypeError("Analysis registration cannot contain accessors");
  return Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, field.value]));
}

export type AnalysisOwnerLoader<Snapshot extends SchemaSnapshot, Policy> = () =>
  | DialectPlugin<Snapshot, Policy>
  | Promise<DialectPlugin<Snapshot, Policy>>;
