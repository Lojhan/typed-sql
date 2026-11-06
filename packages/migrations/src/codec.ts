import { createHash } from "node:crypto";
import type { CatalogEvidence, CheckFinding, JsonValue, MigrationHistory, MigrationPlan } from "./types.js";

export class MigrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
    readonly findings?: readonly CheckFinding[],
  ) {
    super(message);
    this.name = "MigrationError";
  }
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  throw new MigrationError(
    "MIGRATION_VALUE",
    "Migration artifacts only support finite JSON values; encode bigint, bytes and dates explicitly.",
  );
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function hashBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function jsonValue(value: unknown): JsonValue {
  canonical(value);
  return value as JsonValue;
}
export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new MigrationError("MIGRATION_FORMAT", `${label} must be an object.`);
  return value as Record<string, unknown>;
}
export function parsePlan(value: unknown): MigrationPlan {
  const record = object(value, "Migration plan");
  const { hash, ...unsigned } = record;
  if (
    record.formatVersion !== 1 ||
    record.kind !== "typed-sql-migration-plan" ||
    typeof hash !== "string" ||
    digest(unsigned) !== hash ||
    !Array.isArray(record.migrations)
  )
    throw new MigrationError("MIGRATION_PLAN_INVALID", "Invalid or modified migration plan.", 3);
  const target = object(record.target, "Plan target");
  if (record.boundary !== null && typeof record.boundary !== "string")
    throw new MigrationError("MIGRATION_PLAN_INVALID", "Plan boundary must be a migration ID or null.", 3);
  if (
    ["database", "server", "dialect"].some((key) => typeof target[key] !== "string") ||
    !["up", "down"].includes(String(record.direction)) ||
    ["historyHash", "catalogHash", "inventoryHash", "policyHash"].some((key) => !validHash(record[key]))
  )
    throw new MigrationError("MIGRATION_PLAN_INVALID", "Plan identity or hash fields are invalid.", 3);
  parseCatalog(record.starting);
  validateCapturedChecks(record.checks);
  for (const hash of Object.values(object(record.inputs, "Plan input identities")))
    if (!validHash(hash)) throw new MigrationError("MIGRATION_PLAN_INVALID", "Plan input identity is invalid.", 3);
  for (const expected of Object.values(object(record.expected, "Plan expected schemas"))) parseCatalog(expected);
  for (const migration of record.migrations) {
    const m = object(migration, "Captured migration");
    const expected = object(record.expected, "Plan expected schemas");
    if (typeof m.id === "string") parseCatalog(expected[m.id]);
    validateCapturedChecks(m.checks);
    if (
      typeof m.id !== "string" ||
      !validHash(m.hash) ||
      !["required", "none"].includes(String(m.transaction)) ||
      !Array.isArray(m.up) ||
      !m.up.length
    )
      throw new MigrationError("MIGRATION_PLAN_INVALID", "Invalid captured migration.", 3);
    for (const statement of [...m.up, ...(Array.isArray(m.down) ? m.down : [])]) {
      const s = object(statement, "Captured SQL");
      if (typeof s.text !== "string" || !Array.isArray(s.values))
        throw new MigrationError("MIGRATION_PLAN_INVALID", "Invalid captured SQL.", 3);
      canonical(s.values);
    }
    const { hash: capturedHash, ...captured } = m;
    if (digest(captured) !== capturedHash)
      throw new MigrationError("MIGRATION_PLAN_INVALID", "Captured migration hash mismatch.", 3);
    for (const fileHash of Object.values(object(m.files, "Captured files")))
      if (!validHash(fileHash))
        throw new MigrationError("MIGRATION_PLAN_INVALID", "Invalid captured file identity.", 3);
  }
  return record as unknown as MigrationPlan;
}
export function emptyHistory(): MigrationHistory {
  return { formatVersion: 1, applied: [], attempts: [] };
}
export function parseHistory(value: unknown): MigrationHistory {
  const record = object(value, "Migration history");
  if (record.formatVersion !== 1 || !Array.isArray(record.applied) || !Array.isArray(record.attempts))
    throw new MigrationError("MIGRATION_HISTORY_INVALID", "Unsupported migration history format.", 3);
  canonical(record);
  const attempts = new Set<string>();
  for (const entry of record.attempts) {
    const a = object(entry, "History attempt");
    if (
      typeof a.id !== "string" ||
      attempts.has(a.id) ||
      typeof a.migrationId !== "string" ||
      !validHash(a.hash) ||
      !["up", "down"].includes(String(a.direction)) ||
      !["running", "applied", "rolled-back", "unknown", "blocked", "resolved"].includes(String(a.state))
    )
      throw new MigrationError("MIGRATION_HISTORY_INVALID", "Invalid or duplicate migration attempt.", 3);
    attempts.add(a.id);
    for (const field of ["startedAt", "finishedAt"])
      if (a[field] !== undefined && (typeof a[field] !== "string" || !Number.isFinite(Date.parse(a[field] as string))))
        throw new MigrationError("MIGRATION_HISTORY_INVALID", "Invalid migration attempt timestamp.", 3);
    if (
      a.durationMs !== undefined &&
      (typeof a.durationMs !== "number" || !Number.isFinite(a.durationMs) || a.durationMs < 0)
    )
      throw new MigrationError("MIGRATION_HISTORY_INVALID", "Invalid migration duration.", 3);
    if (a.resolution !== undefined && !["confirm-applied", "confirm-not-applied"].includes(String(a.resolution)))
      throw new MigrationError("MIGRATION_HISTORY_INVALID", "Invalid resolution state.", 3);
    if (a.beforeCatalog !== undefined) parseCatalog(a.beforeCatalog);
    if (a.expectedCatalog !== undefined) parseCatalog(a.expectedCatalog);
  }
  const applied = new Set<string>();
  for (const entry of record.applied) {
    const a = object(entry, "Applied migration");
    if (
      typeof a.id !== "string" ||
      applied.has(a.id) ||
      !validHash(a.hash) ||
      typeof a.attemptId !== "string" ||
      !attempts.has(a.attemptId) ||
      a.direction !== "up" ||
      !["executed", "reconciled", "baseline"].includes(String(a.origin))
    )
      throw new MigrationError("MIGRATION_HISTORY_INVALID", "Invalid applied migration identity.", 3);
    applied.add(a.id);
    if (a.appliedAt !== undefined && (typeof a.appliedAt !== "string" || !Number.isFinite(Date.parse(a.appliedAt))))
      throw new MigrationError("MIGRATION_HISTORY_INVALID", "Invalid application timestamp.", 3);
    const linked = record.attempts.find((entry) => object(entry, "Attempt link").id === a.attemptId) as
      | Record<string, unknown>
      | undefined;
    if (linked?.migrationId !== a.id || linked.hash !== a.hash || linked.direction !== "up")
      throw new MigrationError("MIGRATION_HISTORY_INVALID", "Applied migration does not match its durable attempt.", 3);
    parseCatalog(a.catalog);
  }
  return record as unknown as MigrationHistory;
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
export function parseCatalog(value: unknown): CatalogEvidence {
  const c = object(value, "Catalog evidence");
  if (
    c.formatVersion !== 1 ||
    typeof c.dialect !== "string" ||
    typeof c.serverMajor !== "string" ||
    !Array.isArray(c.namespaces) ||
    c.namespaces.some((ns) => typeof ns !== "string") ||
    !["complete", "unknown"].includes(String(c.coverage))
  )
    throw new MigrationError("MIGRATION_CATALOG_INVALID", "Catalog evidence is invalid.", 3);
  const objects = object(c.objects, "Catalog objects");
  if (c.details !== undefined) {
    const details = object(c.details, "Catalog details");
    for (const [key, detail] of Object.entries(details)) {
      if (!Object.hasOwn(objects, key))
        throw new MigrationError(
          "MIGRATION_CATALOG_INVALID",
          "Catalog details must refer to captured catalog objects.",
          3,
        );
      jsonValue(detail);
    }
  }
  if (c.environment !== undefined) {
    const environment = object(c.environment, "Catalog environment");
    if (
      environment.formatVersion !== 1 ||
      Object.keys(environment).some((key) => !["formatVersion", "settings"].includes(key))
    )
      throw new MigrationError(
        "MIGRATION_CATALOG_INVALID",
        "Unsupported or malformed catalog environment evidence.",
        3,
      );
    object(environment.settings, "Catalog environment settings");
  }
  canonical(c);
  return c as unknown as CatalogEvidence;
}
export function validateCapturedChecks(value: unknown): void {
  const phases = object(value, "Checks");
  for (const [phase, checks] of Object.entries(phases)) {
    if (
      !["beforeBatch", "beforeUp", "afterUp", "beforeDown", "afterDown", "afterBatch"].includes(phase) ||
      !Array.isArray(checks)
    )
      throw new MigrationError("MIGRATION_CHECK", "Invalid check phase.");
    const ids = new Set<string>();
    for (const value of checks) {
      const c = object(value, "Check");
      if (
        Object.keys(c).some(
          (key) => !["id", "kind", "message", "query", "expected", "object", "severity", "schemaHash"].includes(key),
        ) ||
        typeof c.id !== "string" ||
        !c.id ||
        ids.has(c.id) ||
        !["noRows", "boolean", "schemaMatches", "objectExists", "objectAbsent", "applicationSnapshotCurrent"].includes(
          String(c.kind),
        ) ||
        (c.severity !== undefined && !["error", "warning"].includes(String(c.severity))) ||
        (c.message !== undefined && typeof c.message !== "string")
      )
        throw new MigrationError("MIGRATION_CHECK", "Check identity, severity or fields are invalid.");
      ids.add(c.id);
      if (c.kind === "noRows" || c.kind === "boolean") {
        const query = object(c.query, "Check SQL");
        if (typeof query.text !== "string" || !query.text.trim() || !Array.isArray(query.values))
          throw new MigrationError("MIGRATION_CHECK", "Data checks require parameterized captured SQL.");
        canonical(query.values);
      } else if (c.kind === "applicationSnapshotCurrent") {
        if (!validHash(c.schemaHash))
          throw new MigrationError("MIGRATION_CHECK", "Application snapshot checks require a canonical schema hash.");
      } else if (c.kind === "schemaMatches") parseCatalog(c.expected);
      else if (typeof c.object !== "string" || !c.object)
        throw new MigrationError("MIGRATION_CHECK", "Object checks require an exact qualified catalog key.");
    }
  }
}
