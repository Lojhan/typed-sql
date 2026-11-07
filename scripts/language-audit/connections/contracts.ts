import type { DialectServerEvidence } from "../../../packages/core/src/index.js";
import type { NativePrepare } from "../native-description/contracts.js";

export interface AuditConnectionOptions {
  readonly version?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface AuditConnection {
  readonly target: Record<string, unknown>;
  readonly server?: DialectServerEvidence;
  query(sql: string): Promise<readonly Record<string, unknown>[]>;
  readonly prepare: NativePrepare;
  close(): unknown;
}

export interface AuditConnectionOwner {
  readonly id: string;
  readonly captureTargets?: readonly string[];
  connect(options: AuditConnectionOptions): Promise<AuditConnection>;
  completeInventory?(
    capture: Awaited<ReturnType<typeof import("../inventory.mjs").collectLive>>,
    connection: AuditConnection,
  ): Promise<void>;
}

export type AuditConnectionDefinition = { id: string; extends?: string } & Partial<Omit<AuditConnectionOwner, "id">>;
