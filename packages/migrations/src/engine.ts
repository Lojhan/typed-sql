import { randomUUID } from "node:crypto";
import type { SqlRenderer } from "@typed-sql/core";
import { digest, emptyHistory, MigrationError, parseCatalog, parsePlan } from "./codec.js";
import { captureChecks } from "./definition.js";
import { inventoryFiles, loadInventory, verifyInputFiles } from "./inventory.js";
import type {
  AppliedMigration,
  CapturedChecks,
  CapturedMigration,
  CatalogEvidence,
  CheckFinding,
  CheckPhase,
  MigrationAttempt,
  MigrationDirection,
  MigrationHistory,
  MigrationPlan,
  MigrationSession,
  MigrationsConfig,
  MigrationTarget,
  TargetIdentity,
} from "./types.js";

export function assertTarget(actual: TargetIdentity, target: MigrationTarget): void {
  if (
    actual.database !== target.expected.database ||
    (target.expected.server !== undefined && actual.server !== target.expected.server)
  )
    throw new MigrationError(
      "MIGRATION_TARGET",
      "Observed database identity does not match the configured expected target.",
      3,
    );
}
export function assertCatalog(catalog: CatalogEvidence): void {
  parseCatalog(catalog);
  if (catalog.coverage !== "complete")
    throw new MigrationError(
      "MIGRATION_COVERAGE",
      "Required catalog evidence is incomplete; execution remains blocked.",
    );
}
export function catalogChanges(
  expected: CatalogEvidence,
  actual: CatalogEvidence,
): readonly { kind: string; object: string }[] {
  assertCatalog(expected);
  assertCatalog(actual);
  if (expected.environment !== undefined || actual.environment !== undefined) {
    if (
      expected.environment === undefined ||
      actual.environment === undefined ||
      digest(expected.environment) !== digest(actual.environment)
    )
      throw new MigrationError(
        "MIGRATION_ENVIRONMENT",
        "Persistent database default-environment evidence is missing or differs from expected replay/history; compare encoding, collation and locale settings before migration.",
        3,
      );
  }
  if (
    expected.dialect !== actual.dialect ||
    expected.serverMajor !== actual.serverMajor ||
    digest(expected.namespaces) !== digest(actual.namespaces)
  )
    throw new MigrationError(
      "MIGRATION_ENVIRONMENT",
      "Catalog dialect, server major or managed namespaces differ from expected evidence.",
    );
  const changes: { kind: string; object: string }[] = [];
  for (const key of new Set([...Object.keys(expected.objects), ...Object.keys(actual.objects)])) {
    if (!(key in expected.objects)) changes.push({ kind: "added", object: key });
    else if (!(key in actual.objects)) changes.push({ kind: "removed", object: key });
    else if (digest(expected.objects[key]) !== digest(actual.objects[key]))
      changes.push({ kind: "changed", object: key });
  }
  return changes.sort((a, b) => (a.object < b.object ? -1 : a.object > b.object ? 1 : 0));
}
function requireEqual(expected: CatalogEvidence, actual: CatalogEvidence): void {
  const changes = catalogChanges(expected, actual);
  if (changes.length)
    throw new MigrationError(
      "MIGRATION_DRIFT",
      `Schema drift blocks migrations (${changes.map((c) => `${c.kind} ${c.object}`).join(", ")}). Remove the out-of-band change or create an explicit reconciliation plan.`,
      3,
    );
}
export function validateHistory(history: MigrationHistory, migrations: readonly CapturedMigration[]): void {
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const ids = new Set<string>();
  for (const attempt of history.attempts) {
    if (attempt.state === "applied" || (attempt.state === "resolved" && attempt.resolution === "confirm-applied")) {
      const historical = byId.get(attempt.migrationId);
      if (historical === undefined || historical.hash !== attempt.hash)
        throw new MigrationError(
          "MIGRATION_HISTORY_DIVERGED",
          `Historical migration ${attempt.migrationId} is missing or changed, including after reversal.`,
          3,
        );
    }
  }
  let previous = "";
  for (const applied of history.applied) {
    if (ids.has(applied.id) || applied.id <= previous)
      throw new MigrationError(
        "MIGRATION_HISTORY_ORDER",
        "Applied migration history is duplicated or out of order.",
        3,
      );
    ids.add(applied.id);
    previous = applied.id;
    const current = byId.get(applied.id);
    if (current === undefined || current.hash !== applied.hash)
      throw new MigrationError(
        "MIGRATION_HISTORY_DIVERGED",
        `Applied migration ${applied.id} is missing or changed. Never rewrite applied history.`,
        3,
      );
  }
  for (const attempt of history.attempts)
    if (["running", "unknown"].includes(attempt.state) && !history.applied.some((a) => a.attemptId === attempt.id))
      throw new MigrationError(
        "MIGRATION_OUTCOME_UNKNOWN",
        `Migration ${attempt.migrationId} has unresolved attempt ${attempt.id}. Inspect the database and resolve explicitly.`,
        4,
      );
  for (const migration of migrations)
    if (migration.id < previous && !ids.has(migration.id))
      throw new MigrationError(
        "MIGRATION_OUT_OF_ORDER",
        `Unapplied migration ${migration.id} precedes the deployed head; reconcile branch history explicitly.`,
        3,
      );
}
function emptyCatalog(reference: CatalogEvidence): CatalogEvidence {
  return {
    ...reference,
    objects: Object.fromEntries(Object.entries(reference.objects).filter(([key]) => key.startsWith("namespace:"))),
  };
}
function expectedHead(history: MigrationHistory, current: CatalogEvidence): CatalogEvidence {
  return history.applied.at(-1)?.catalog ?? emptyCatalog(current);
}
export function effectiveChecks(
  global: CapturedChecks,
  local: CapturedChecks,
  phase: CheckPhase,
): readonly NonNullable<CapturedChecks[CheckPhase]>[number][] {
  const byId = new Map<string, NonNullable<CapturedChecks[CheckPhase]>[number]>();
  for (const check of [...(global[phase] ?? []), ...(local[phase] ?? [])]) {
    const previous = byId.get(check.id);
    if (previous !== undefined && digest(previous) !== digest(check))
      throw new MigrationError(
        "MIGRATION_CHECK_CONFLICT",
        `Check ${check.id} has conflicting global/local definitions.`,
      );
    byId.set(check.id, check);
  }
  return [...byId.values()];
}
export function batchCheckPolicy(global: CapturedChecks, migrations: readonly CapturedMigration[]): CapturedChecks {
  return {
    beforeBatch: migrations.reduce(
      (checks, migration) => effectiveChecks({ beforeBatch: checks }, migration.checks, "beforeBatch"),
      global.beforeBatch ?? [],
    ),
    afterBatch: migrations.reduce(
      (checks, migration) => effectiveChecks({ afterBatch: checks }, migration.checks, "afterBatch"),
      global.afterBatch ?? [],
    ),
  };
}
export async function runChecks(
  session: MigrationSession,
  global: CapturedChecks,
  local: CapturedChecks,
  phase: CheckPhase,
): Promise<readonly CheckFinding[]> {
  const findings: CheckFinding[] = [];
  for (const check of effectiveChecks(global, local, phase)) {
    let passed = false;
    try {
      if (check.kind === "applicationSnapshotCurrent") {
        if (!session.snapshotHash || !check.schemaHash)
          throw new MigrationError(
            "MIGRATION_APPLICATION_SNAPSHOT",
            "Adapter cannot establish application snapshot freshness.",
          );
        passed = (await session.snapshotHash()) === check.schemaHash;
      } else if (check.kind === "noRows" || check.kind === "boolean") {
        if (check.query === undefined) throw new MigrationError("MIGRATION_CHECK", "Data checks require captured SQL.");
        passed = await session.check(check.query, check.kind);
      } else {
        const catalog = await session.capture();
        assertCatalog(catalog);
        if (check.kind === "schemaMatches") {
          if (check.expected === undefined)
            throw new MigrationError("MIGRATION_CHECK", "Schema checks require immutable expected evidence.");
          passed = catalogChanges(check.expected, catalog).length === 0;
        } else {
          if (check.object === undefined)
            throw new MigrationError("MIGRATION_CHECK", "Object checks require a qualified catalog key.");
          passed = check.object in catalog.objects === (check.kind === "objectExists");
        }
      }
    } catch {
      findings.push({
        id: check.id,
        phase,
        status: "unknown",
        message: check.message ?? "Check could not establish required evidence.",
        severity: check.severity ?? "error",
      });
      continue;
    }
    findings.push({
      id: check.id,
      phase,
      status: passed ? "passed" : "failed",
      message: check.message ?? (passed ? "Condition satisfied." : "Condition was not satisfied."),
      severity: check.severity ?? "error",
    });
  }
  const blocked = findings.filter((f) => f.status !== "passed" && f.severity === "error");
  if (blocked.length)
    throw new MigrationError(
      "MIGRATION_CHECK_BLOCKED",
      `Migration checks blocked execution: ${blocked.map((f) => `${f.id} (${f.status}): ${f.message}`).join("; ")}`,
      1,
      findings,
    );
  return findings;
}
/** Independent replay in an explicitly disposable empty database. Never resets/provisions a database. */
export async function replayEvidence(
  target: MigrationTarget,
  migrations: readonly CapturedMigration[],
  protectedTarget?: TargetIdentity,
  environment?: CatalogEvidence,
  observe?: (session: MigrationSession, migrationId: string | null) => Promise<void>,
): Promise<{ starting: CatalogEvidence; expected: Readonly<Record<string, CatalogEvidence>> }> {
  if (!target.disposable || target.classification === "production")
    throw new MigrationError(
      "MIGRATION_REPLAY_TARGET",
      "Replay requires an explicitly disposable nonproduction target.",
    );
  const session = await target.connect();
  let transaction = false;
  try {
    const identity = await session.identity();
    assertTarget(identity, target);
    // Distinct database names remain unambiguous even through socket/proxy/address aliases.
    if (protectedTarget !== undefined && identity.database === protectedTarget.database)
      throw new MigrationError(
        "MIGRATION_REPLAY_IDENTITY",
        "Replay requires a different database name from the application target; aliases or a disposable flag cannot authorize replay on the live database.",
        3,
      );
    await session.lock(10000);
    const starting = await session.capture();
    assertCatalog(starting);
    if (
      Object.keys(starting.objects).some((key) => !key.startsWith("namespace:")) ||
      (await session.history()).applied.length
    )
      throw new MigrationError(
        "MIGRATION_REPLAY_NOT_EMPTY",
        "Replay target must have an empty managed schema and no applied history. No reset is performed.",
      );
    if (environment !== undefined) requireEqual(emptyCatalog(environment), starting);
    transaction = migrations.every((m) => m.transaction === "required");
    if (transaction) await session.begin();
    await observe?.(session, null);
    const expected: Record<string, CatalogEvidence> = {};
    for (const migration of migrations) {
      session.validate(migration.up, migration.transaction);
      for (const statement of migration.up) await session.execute(statement);
      expected[migration.id] = await session.capture();
      assertCatalog(expected[migration.id]!);
      await observe?.(session, migration.id);
    }
    if (transaction) {
      await session.rollback();
      transaction = false;
    }
    return { starting, expected };
  } finally {
    if (transaction) await session.rollback().catch(() => undefined);
    await session.unlock().catch(() => undefined);
    await session.close();
  }
}
export interface PlanOptions {
  readonly root: string;
  readonly config: MigrationsConfig;
  readonly renderer: SqlRenderer;
  readonly target: string;
  readonly to?: string;
  readonly direction?: MigrationDirection;
  readonly reconcile?: boolean;
}
export async function createPlan(options: PlanOptions): Promise<MigrationPlan> {
  const { root, config, renderer } = options;
  const target = config.targets[options.target];
  if (!target) throw new MigrationError("MIGRATION_TARGET", "Select a configured migration target.", 2);
  const inventory = await loadInventory(root, config.directory, renderer);
  const global = captureChecks(config.checks, renderer);
  const session = await target.connect();
  try {
    const identity = await session.identity();
    assertTarget(identity, target);
    const history = await session.history();
    validateHistory(history, inventory.migrations);
    const catalog = await session.capture();
    assertCatalog(catalog);
    if (
      config.policy?.managedNamespaces !== undefined &&
      digest([...config.policy.managedNamespaces].sort()) !== digest([...catalog.namespaces].sort())
    )
      throw new MigrationError(
        "MIGRATION_SCOPE",
        "Adapter capture scope does not match the global managedNamespaces policy.",
        3,
      );
    if (!options.reconcile) requireEqual(expectedHead(history, catalog), catalog);
    const direction = options.direction ?? "up";
    let selected: readonly CapturedMigration[];
    if (direction === "up") {
      selected = inventory.migrations.filter((m) => !history.applied.some((a) => a.id === m.id));
      if (options.to !== undefined) {
        const index = selected.findIndex((m) => m.id === options.to);
        if (index < 0) throw new MigrationError("MIGRATION_TO", "--to must select a pending migration.", 2);
        selected = selected.slice(0, index + 1);
      }
    } else {
      if (options.to !== undefined && options.to !== "empty" && !history.applied.some((a) => a.id === options.to))
        throw new MigrationError("MIGRATION_TO", "Revert --to must name the last retained migration or empty.", 2);
      const suffix = history.applied
        .filter((a) => options.to === "empty" || options.to === undefined || a.id > options.to)
        .reverse();
      selected = suffix.map((a) => inventory.migrations.find((m) => m.id === a.id)!);
      for (const m of selected)
        if (!m.down?.length)
          throw new MigrationError("MIGRATION_IRREVERSIBLE", `Migration ${m.id} has no declared down operation.`);
    }
    let starting = expectedHead(history, catalog);
    const expected: Record<string, CatalogEvidence> = {};
    if (direction === "up" && selected.length) {
      const replay = config.replayTarget === undefined ? undefined : config.targets[config.replayTarget];
      if (!replay)
        throw new MigrationError(
          "MIGRATION_REPLAY_REQUIRED",
          "Configure a disposable replayTarget to independently prove expected schema before applying migrations.",
        );
      const evidence = await replayEvidence(
        replay,
        inventory.migrations.filter((m) => m.id <= selected.at(-1)!.id),
        identity,
        catalog,
      );
      starting = history.applied.length ? evidence.expected[history.applied.at(-1)!.id]! : evidence.starting;
      if (starting === undefined)
        throw new MigrationError("MIGRATION_EVIDENCE", "Replay did not establish the current history head.");
      if (!options.reconcile) requireEqual(starting, catalog);
      Object.assign(expected, evidence.expected);
    } else if (direction === "down") {
      for (const migration of selected) {
        const index = history.applied.findIndex((a) => a.id === migration.id);
        expected[migration.id] = index === 0 ? emptyCatalog(catalog) : history.applied[index - 1]!.catalog;
      }
    }
    for (const migration of selected)
      session.validate(direction === "up" ? migration.up : migration.down!, migration.transaction);
    const unsigned = {
      formatVersion: 1 as const,
      kind: "typed-sql-migration-plan" as const,
      target: identity,
      historyHash: digest(history),
      catalogHash: digest(catalog),
      inventoryHash: digest(inventory.files),
      inputs: inventory.inputs,
      policyHash: digest({ policy: config.policy ?? {}, checks: global }),
      direction,
      boundary: options.to ?? null,
      migrations: selected,
      checks: global,
      expected,
      starting,
    };
    return { ...unsigned, hash: digest(unsigned) };
  } finally {
    await session.close();
  }
}
function replaceAttempt(history: MigrationHistory, attempt: MigrationAttempt): MigrationHistory {
  return { ...history, attempts: [...history.attempts.filter((a) => a.id !== attempt.id), attempt] };
}
export async function applyPlan(
  options: Omit<PlanOptions, "direction" | "to"> & { readonly plan: MigrationPlan; readonly reason?: string },
): Promise<{
  readonly applied: readonly string[];
  readonly history: MigrationHistory;
  readonly findings: readonly CheckFinding[];
}> {
  const plan = parsePlan(options.plan),
    target = options.config.targets[options.target];
  if (!target) throw new MigrationError("MIGRATION_TARGET", "Select a configured target.", 2);
  const verifyInputs = async () => {
    await verifyInputFiles(options.root, plan.inputs);
    if (digest(await inventoryFiles(options.root, options.config.directory)) !== plan.inventoryHash)
      throw new MigrationError("MIGRATION_INVENTORY_CHANGED", "Migration inventory changed after plan review.", 3);
    if (
      digest({
        policy: options.config.policy ?? {},
        checks: captureChecks(options.config.checks, options.renderer),
      }) !== plan.policyHash
    )
      throw new MigrationError("MIGRATION_POLICY_CHANGED", "Migration policy changed after plan review.", 3);
  };
  await verifyInputs();
  const session = await target.connect();
  let inTransaction = false;
  try {
    const identity = await session.identity();
    assertTarget(identity, target);
    if (digest(identity) !== digest(plan.target))
      throw new MigrationError("MIGRATION_TARGET", "Plan belongs to a different target.", 3);
    await session.lock(options.config.policy?.lockTimeoutMs ?? 10000);
    await verifyInputs();
    for (const migration of plan.migrations)
      session.validate(plan.direction === "up" ? migration.up : (migration.down ?? []), migration.transaction);
    let history = await session.history();
    if (digest(history) !== plan.historyHash || digest(await session.capture()) !== plan.catalogHash)
      throw new MigrationError(
        "MIGRATION_PLAN_STALE",
        "Database history or catalog changed since the plan was created.",
        3,
      );
    if (options.reconcile) {
      if (plan.direction !== "up" || !options.reason?.trim() || plan.migrations.length !== 1)
        throw new MigrationError(
          "MIGRATION_RECONCILE",
          "Reconciliation requires one up migration and an operator reason.",
        );
      requireEqual(plan.expected[plan.migrations[0]!.id]!, await session.capture());
      const migration = plan.migrations[0]!;
      if (!migration.reconciliation)
        throw new MigrationError(
          "MIGRATION_RECONCILE_INTENT",
          "Declare migration-local reconciliation reason and exact expectedObjects before adoption.",
        );
      session.validateReconciliation(migration.up);
      const changes = catalogChanges(plan.starting, plan.expected[migration.id]!);
      if (
        changes.length === 0 ||
        digest(changes.map((c) => c.object).sort()) !== digest([...migration.reconciliation.expectedObjects].sort())
      )
        throw new MigrationError(
          "MIGRATION_RECONCILE_SCOPE",
          "Declared reconciliation objects must exactly cover the independently replayed schema changes.",
          3,
        );
    } else requireEqual(plan.starting, await session.capture());
    const batchChecks = batchCheckPolicy(plan.checks, plan.migrations);
    const findings: CheckFinding[] = [...(await runChecks(session, batchChecks, {}, "beforeBatch"))];
    await session.bootstrap();
    const completed: string[] = [];
    for (const migration of plan.migrations) {
      const attempt: MigrationAttempt = {
        startedAt: new Date().toISOString(),
        id: randomUUID(),
        migrationId: migration.id,
        hash: migration.hash,
        direction: plan.direction,
        state: "running",
        beforeCatalog: await session.capture(),
        expectedCatalog: plan.expected[migration.id]!,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      };
      history = replaceAttempt(history, attempt);
      await session.saveHistory(history);
      const beforeAttempt = history;
      let commitStarted = false;
      try {
        if (migration.transaction === "required" || options.reconcile) {
          await session.begin();
          inTransaction = true;
        }
        const before = plan.direction === "up" ? "beforeUp" : "beforeDown",
          after = plan.direction === "up" ? "afterUp" : "afterDown";
        // Reconciliation verifies the complete post-state instead of replaying beforeUp assumptions.
        if (!options.reconcile)
          findings.push(
            ...(await runChecks(session, plan.checks, migration.checks, before)).map((f) => ({
              ...f,
              migrationId: migration.id,
            })),
          );
        if (!options.reconcile)
          for (const statement of plan.direction === "up" ? migration.up : migration.down!)
            await session.execute(statement);
        findings.push(
          ...(await runChecks(session, plan.checks, migration.checks, after)).map((f) => ({
            ...f,
            migrationId: migration.id,
          })),
        );
        const actual = await session.capture();
        requireEqual(plan.expected[migration.id]!, actual);
        const applied: AppliedMigration = {
          appliedAt: new Date().toISOString(),
          id: migration.id,
          hash: migration.hash,
          catalog: plan.expected[migration.id]!,
          direction: plan.direction,
          attemptId: attempt.id,
          origin: options.reconcile ? "reconciled" : "executed",
        };
        history = replaceAttempt(
          {
            ...history,
            applied:
              plan.direction === "up"
                ? [...history.applied, applied]
                : history.applied.filter((a) => a.id !== migration.id),
          },
          {
            ...attempt,
            state: "applied",
            finishedAt: new Date().toISOString(),
            durationMs: Math.max(0, Date.now() - Date.parse(attempt.startedAt!)),
          },
        );
        await session.saveHistory(history);
        if (inTransaction) {
          commitStarted = true;
          await session.commit();
          inTransaction = false;
        }
        completed.push(migration.id);
      } catch (error) {
        let rolledBack = false;
        if (inTransaction) {
          try {
            await session.rollback();
            rolledBack = !commitStarted;
          } catch {}
          inTransaction = false;
        }
        const persisted = await session.history().catch(() => undefined);
        if (persisted?.applied.some((a) => a.attemptId === attempt.id)) {
          throw new MigrationError(
            "MIGRATION_COMMIT_UNKNOWN",
            "Commit response failed; durable applied evidence exists. Inspect status before continuing.",
            4,
          );
        }
        const state = rolledBack ? "rolled-back" : "unknown";
        history = replaceAttempt(persisted ?? beforeAttempt, {
          ...attempt,
          state,
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - Date.parse(attempt.startedAt!)),
          code: error instanceof MigrationError ? error.code : "MIGRATION_SQL_FAILED",
        });
        await session.saveHistory(history).catch(() => undefined);
        if (!rolledBack)
          throw new MigrationError(
            "MIGRATION_OUTCOME_UNKNOWN",
            `Migration ${migration.id} may have committed effects. Inspect attempt ${attempt.id}; automatic retry is blocked.`,
            4,
          );
        if (error instanceof MigrationError)
          throw new MigrationError(
            error.code,
            `${error.message}${completed.length ? ` Previously committed migrations: ${completed.join(", ")}.` : ""}`,
            error.exitCode,
            [...findings, ...(error.findings ?? [])],
          );
        throw new MigrationError(
          "MIGRATION_SQL_FAILED",
          `Migration ${migration.id} failed and its transaction rolled back. Inspect the migration SQL and retry with a new plan.`,
        );
      }
    }
    try {
      findings.push(...(await runChecks(session, batchChecks, {}, "afterBatch")));
    } catch (error) {
      throw new MigrationError(
        "MIGRATION_AFTER_BATCH",
        `Migration SQL committed for ${completed.join(", ")}; afterBatch checks failed: ${error instanceof MigrationError ? error.message : "required evidence unavailable"}`,
        1,
        [...findings, ...(error instanceof MigrationError ? (error.findings ?? []) : [])],
      );
    }
    return { applied: completed, history, findings };
  } finally {
    if (inTransaction) await session.rollback().catch(() => undefined);
    await session.unlock().catch(() => undefined);
    await session.close();
  }
}
export async function inspectMigrations(options: PlanOptions): Promise<{
  identity: TargetIdentity;
  history: MigrationHistory;
  pending: readonly string[];
  drift: readonly { kind: string; object: string }[];
  diagnostics: readonly { code: string; message: string }[];
  driftState: "current" | "drifted" | "unknown";
  historyHash: string;
  catalogHash: string;
  targetHash: string;
  resolutionEvidence: readonly Record<string, unknown>[];
}> {
  const inventory = await loadInventory(options.root, options.config.directory, options.renderer);
  const target = options.config.targets[options.target];
  if (!target) throw new MigrationError("MIGRATION_TARGET", "Select a configured target.", 2);
  const session = await target.connect();
  try {
    const identity = await session.identity();
    assertTarget(identity, target);
    const history = await session.history();
    const diagnostics: { code: string; message: string }[] = [];
    try {
      validateHistory(history, inventory.migrations);
    } catch (error) {
      if (error instanceof MigrationError) diagnostics.push({ code: error.code, message: error.message });
      else throw error;
    }
    const live = await session.capture();
    let drift: readonly { kind: string; object: string }[] = [];
    let driftState: "current" | "drifted" | "unknown" = "unknown";
    try {
      drift = catalogChanges(expectedHead(history, live), live);
      driftState = drift.length ? "drifted" : "current";
    } catch (error) {
      if (error instanceof MigrationError) diagnostics.push({ code: error.code, message: error.message });
      else throw error;
    }
    const historyHash = digest(history),
      catalogHash = digest(live),
      targetHash = digest(identity);
    return {
      identity,
      history,
      pending: inventory.migrations.filter((m) => !history.applied.some((a) => a.id === m.id)).map((m) => m.id),
      drift,
      diagnostics,
      driftState,
      historyHash,
      catalogHash,
      targetHash,
      resolutionEvidence: history.attempts
        .filter(
          (a) => ["running", "unknown"].includes(a.state) && !history.applied.some((entry) => entry.attemptId === a.id),
        )
        .map((a) => ({
          attemptId: a.id,
          migrationId: a.migrationId,
          hash: a.hash,
          historyHash,
          catalogHash,
          targetHash,
          effectsVerified: false,
        })),
    };
  } finally {
    await session.close();
  }
}
export function migrationPlanReport(plan: MigrationPlan): unknown {
  return {
    formatVersion: 1,
    kind: "typed-sql-migration-report",
    hash: plan.hash,
    target: plan.target,
    direction: plan.direction,
    boundary: plan.boundary,
    checks: Object.entries(plan.checks).flatMap(([phase, checks]) =>
      checks.map((c) => ({ id: c.id, phase, scope: "project", status: "deferred" })),
    ),
    migrations: plan.migrations.map((m) => ({
      id: m.id,
      hash: m.hash,
      transaction: m.transaction,
      operations: (plan.direction === "up" ? m.up : (m.down ?? [])).length,
      checks: Object.entries(m.checks).flatMap(([phase, checks]) =>
        checks.map((c) => ({ id: c.id, phase, status: "deferred" })),
      ),
    })),
  };
}
export { emptyHistory };
