import type { Query } from "@typed-sql/core";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type MigrationDirection = "up" | "down";
export type CheckPhase = "beforeBatch" | "beforeUp" | "afterUp" | "beforeDown" | "afterDown" | "afterBatch";
export interface MigrationStatement {
  readonly text: string;
  readonly values: readonly JsonValue[];
}
export type MigrationSql = string | Query<unknown> | MigrationStatement;
export interface MigrationCheck {
  readonly id: string;
  readonly kind: "noRows" | "boolean" | "schemaMatches" | "objectExists" | "objectAbsent";
  readonly message?: string;
  readonly query?: MigrationSql;
  readonly expected?: CatalogEvidence;
  readonly object?: string;
  readonly severity?: "error" | "warning";
}
export type MigrationChecks = Partial<Readonly<Record<CheckPhase, readonly MigrationCheck[]>>>;
export interface MigrationDefinition {
  readonly id: string;
  readonly description?: string;
  readonly transaction?: "required" | "none";
  readonly up: readonly MigrationSql[];
  readonly down?: readonly MigrationSql[];
  readonly irreversibleReason?: string;
  readonly checks?: MigrationChecks;
  readonly reconciliation?: { readonly reason: string; readonly expectedObjects: readonly string[] };
}
export interface CapturedCheck extends Omit<MigrationCheck, "query"> {
  readonly query?: MigrationStatement;
}
export type CapturedChecks = Partial<Readonly<Record<CheckPhase, readonly CapturedCheck[]>>>;
export interface CapturedMigration {
  readonly id: string;
  readonly description: string;
  readonly transaction: "required" | "none";
  readonly up: readonly MigrationStatement[];
  readonly down?: readonly MigrationStatement[];
  readonly irreversibleReason?: string;
  readonly checks: CapturedChecks;
  readonly hash: string;
  readonly files: Readonly<Record<string, string>>;
  readonly reconciliation?: { readonly reason: string; readonly expectedObjects: readonly string[] };
}
export interface CatalogEvidence {
  readonly formatVersion: 1;
  readonly dialect: string;
  readonly serverMajor: string;
  readonly namespaces: readonly string[];
  readonly objects: Readonly<Record<string, JsonValue>>;
  readonly coverage: "complete" | "unknown";
}
export interface TargetIdentity {
  readonly database: string;
  readonly server: string;
  readonly dialect: string;
}
export interface AppliedMigration {
  readonly id: string;
  readonly hash: string;
  readonly catalog: CatalogEvidence;
  readonly direction: MigrationDirection;
  readonly attemptId: string;
  readonly origin: "executed" | "reconciled" | "baseline";
}
export interface MigrationAttempt {
  readonly id: string;
  readonly migrationId: string;
  readonly hash: string;
  readonly direction: MigrationDirection;
  readonly state: "running" | "applied" | "rolled-back" | "unknown" | "blocked" | "resolved";
  readonly code?: string;
  readonly reason?: string;
  readonly resolution?: "confirm-applied" | "confirm-not-applied";
  readonly beforeCatalog?: CatalogEvidence;
  readonly expectedCatalog?: CatalogEvidence;
}
export interface MigrationHistory {
  readonly formatVersion: 1;
  readonly applied: readonly AppliedMigration[];
  readonly attempts: readonly MigrationAttempt[];
}
/** A pinned database session. Dialect SQL, locks, catalog capture and ledger writes belong to the adapter. */
export interface MigrationSession {
  identity(): Promise<TargetIdentity>;
  capture(): Promise<CatalogEvidence>;
  history(): Promise<MigrationHistory>;
  lock(timeoutMs: number): Promise<void>;
  unlock(): Promise<void>;
  bootstrap(): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  execute(statement: MigrationStatement): Promise<readonly Readonly<Record<string, unknown>>[]>;
  check(statement: MigrationStatement, kind: "noRows" | "boolean"): Promise<boolean>;
  validate(statements: readonly MigrationStatement[], transaction: "required" | "none"): void;
  validateReconciliation(statements: readonly MigrationStatement[]): void;
  saveHistory(history: MigrationHistory): Promise<void>;
  close(): Promise<void>;
}
export interface MigrationTarget {
  readonly classification: "development" | "test" | "production";
  readonly expected: { readonly database: string; readonly server?: string };
  readonly disposable?: boolean;
  connect(): Promise<MigrationSession>;
}
export interface MigrationsConfig {
  readonly directory: string;
  readonly policyFile?: string;
  readonly targets: Readonly<Record<string, MigrationTarget>>;
  readonly replayTarget?: string;
  readonly checks?: MigrationChecks;
  readonly policy?: {
    readonly drift?: "block";
    readonly unknownEvidence?: "block";
    readonly lockTimeoutMs?: number;
    readonly managedNamespaces?: readonly string[];
    readonly authoring?: "require-current-schema-when-connected";
    readonly reconciliation?: "explicit-evidence";
  };
}
export interface MigrationPlan {
  readonly formatVersion: 1;
  readonly kind: "typed-sql-migration-plan";
  readonly target: TargetIdentity;
  readonly historyHash: string;
  readonly catalogHash: string;
  readonly inventoryHash: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly policyHash: string;
  readonly direction: MigrationDirection;
  readonly migrations: readonly CapturedMigration[];
  readonly checks: CapturedChecks;
  readonly expected: Readonly<Record<string, CatalogEvidence>>;
  readonly starting: CatalogEvidence;
  readonly hash: string;
}
export interface CheckFinding {
  readonly id: string;
  readonly phase: CheckPhase;
  readonly status: "passed" | "failed" | "unknown";
  readonly message: string;
  readonly severity: "error" | "warning";
}
