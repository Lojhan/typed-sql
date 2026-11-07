export type ExplorerValue = null | boolean | number | string | ExplorerValue[] | { [key: string]: ExplorerValue };
export interface ExplorerEvent {
  migrationId: string;
  attemptId: string;
  direction: "up" | "down";
  origin: "executed" | "reconciled" | "baseline" | "resolved" | "unknown";
  state: string;
  startedAt?: string;
  finishedAt?: string;
  change: "added" | "removed" | "changed" | "unchanged" | "unknown";
  before?: ExplorerValue;
  after?: ExplorerValue;
  evidence: "captured" | "expected" | "unknown";
  details?: "captured" | "fingerprint-only";
  changes?: ExplorerEvent[];
  objectId?: string;
  catalogKey?: string;
}
export interface ExplorerObject {
  id: string;
  kind: string;
  namespace: string;
  name: string;
  parentId?: string;
  details: ExplorerValue;
  history: ExplorerEvent[];
  historyState: "captured" | "unknown" | "unavailable";
  historyMessage?: string;
}
export interface ExplorerMigration {
  id: string;
  description?: string;
  status: "applied" | "pending" | "reverted" | "running" | "blocked" | "unknown" | "unverified" | "diverged";
  files: string[];
  hash?: string;
  localHash?: string;
  message?: string;
  attempts: ExplorerEvent[];
}
export interface ExplorerCatalog {
  schema: {
    schemaHash: string;
    source: string;
    capturedAt: string;
    objects: ExplorerObject[];
    links: {
      id: string;
      source: string;
      target: string;
      kind: "contains" | "foreign-key" | "type" | "index-column";
      label?: string;
    }[];
    coverage: "structural" | "legacy";
  };
  migrations: {
    state: "ready" | "unavailable" | "unconfigured" | "failed";
    message?: string;
    directory?: string;
    entries: ExplorerMigration[];
  };
}
