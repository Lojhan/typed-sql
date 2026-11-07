import type { JsonValue, MigrationHistory } from "@typed-sql/migrations";

/** Adapter-normalized catalog identity. Neutral code never parses grammar-owned ledger keys. */
export interface PlaygroundCatalogObject {
  readonly key: string;
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly parentName?: string;
}
export interface PlaygroundMigrationObservation {
  readonly state: "ready" | "missing";
  readonly database: string;
  readonly historyNamespace?: string;
  readonly history: MigrationHistory;
  readonly objects: readonly PlaygroundCatalogObject[];
}
export interface ExplorerEvent {
  readonly migrationId: string;
  readonly attemptId: string;
  readonly direction: "up" | "down";
  readonly origin: "executed" | "reconciled" | "baseline" | "resolved" | "unknown";
  readonly state: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly change: "added" | "removed" | "changed" | "unchanged" | "unknown";
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  readonly evidence: "captured" | "expected" | "unknown";
  readonly details?: "captured" | "fingerprint-only";
  readonly changes?: readonly ExplorerEvent[];
  readonly objectId?: string;
  readonly catalogKey?: string;
}
export interface ExplorerObject {
  readonly id: string;
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly parentId?: string;
  readonly details: JsonValue;
  readonly history: readonly ExplorerEvent[];
  readonly historyState: "captured" | "unknown" | "unavailable";
  readonly historyMessage?: string;
}
export interface ExplorerLink {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: "contains" | "foreign-key" | "type" | "index-column";
  readonly label?: string;
}
export interface ExplorerMigration {
  readonly id: string;
  readonly description?: string;
  readonly status: "applied" | "pending" | "reverted" | "running" | "blocked" | "unknown" | "unverified" | "diverged";
  readonly files: readonly string[];
  readonly hash?: string;
  readonly localHash?: string;
  readonly message?: string;
  readonly attempts: readonly ExplorerEvent[];
}
export interface ExplorerResponse {
  readonly schema: {
    readonly schemaHash: string;
    readonly source: string;
    readonly capturedAt: string;
    readonly coverage: "structural" | "legacy";
    readonly objects: readonly ExplorerObject[];
    readonly links: readonly ExplorerLink[];
  };
  readonly migrations: {
    readonly state: "ready" | "unavailable" | "unconfigured" | "failed";
    readonly message?: string;
    readonly directory?: string;
    readonly entries: readonly ExplorerMigration[];
  };
}
