export {
  canonical,
  digest,
  emptyHistory,
  hashBytes,
  MigrationError,
  parseCatalog,
  parseHistory,
  parsePlan,
} from "./codec.js";
export {
  captureChecks,
  captureMigration,
  captureStatement,
  checks,
  defineMigration,
  defineMigrations,
} from "./definition.js";
export type { PlanOptions } from "./engine.js";
export {
  applyPlan,
  assertCatalog,
  assertTarget,
  catalogChanges,
  createPlan,
  effectiveChecks,
  inspectMigrations,
  migrationPlanReport,
  replayEvidence,
  runChecks,
  validateHistory,
} from "./engine.js";
export {
  createMigration,
  ensureDirectory,
  inventoryFiles,
  loadInventory,
  safePath,
  verifyCapturedFiles,
} from "./inventory.js";
export { baselinePlan, resolveAttempt } from "./recovery.js";
export type {
  AppliedMigration,
  CapturedCheck,
  CapturedChecks,
  CapturedMigration,
  CatalogEvidence,
  CheckFinding,
  CheckPhase,
  JsonValue,
  MigrationAttempt,
  MigrationCheck,
  MigrationChecks,
  MigrationDefinition,
  MigrationDirection,
  MigrationHistory,
  MigrationPlan,
  MigrationSession,
  MigrationSql,
  MigrationStatement,
  MigrationsConfig,
  MigrationTarget,
  TargetIdentity,
} from "./types.js";
