import { randomUUID } from "node:crypto";
import type { SqlRenderer } from "@typed-sql/core";
import { digest, MigrationError, object, parsePlan } from "./codec.js";
import { captureChecks } from "./definition.js";
import { assertTarget, catalogChanges, runChecks } from "./engine.js";
import { inventoryFiles, verifyInputFiles } from "./inventory.js";
import type { AppliedMigration, MigrationHistory, MigrationPlan, MigrationsConfig } from "./types.js";

export async function baselinePlan(options: {
  readonly root: string;
  readonly config: MigrationsConfig;
  readonly target: string;
  readonly plan: MigrationPlan;
  readonly reason: string;
  readonly renderer: SqlRenderer;
}): Promise<MigrationHistory> {
  const target = options.config.targets[options.target];
  if (!target || !options.reason.trim())
    throw new MigrationError("MIGRATION_BASELINE", "Baseline requires a target and operator reason.");
  const plan = parsePlan(options.plan);
  if (plan.direction !== "up" || !plan.migrations.length)
    throw new MigrationError("MIGRATION_BASELINE", "Baseline requires a reviewed up-prefix replay plan.");
  await verifyInputFiles(options.root, plan.inputs);
  if (digest(await inventoryFiles(options.root, options.config.directory)) !== plan.inventoryHash)
    throw new MigrationError("MIGRATION_INVENTORY_CHANGED", "Baseline inventory changed after review.", 3);
  const session = await target.connect();
  try {
    const identity = await session.identity();
    assertTarget(identity, target);
    if (digest(identity) !== digest(plan.target))
      throw new MigrationError("MIGRATION_TARGET", "Baseline evidence belongs to another target.", 3);
    await session.lock(options.config.policy?.lockTimeoutMs ?? 10000);
    await verifyInputFiles(options.root, plan.inputs);
    if (
      digest({
        policy: options.config.policy ?? {},
        checks: captureChecks(options.config.checks, options.renderer),
      }) !== plan.policyHash
    )
      throw new MigrationError("MIGRATION_POLICY_CHANGED", "Baseline policy changed after review.", 3);
    if (digest(await inventoryFiles(options.root, options.config.directory)) !== plan.inventoryHash)
      throw new MigrationError(
        "MIGRATION_INVENTORY_CHANGED",
        "Baseline inventory changed while waiting for the lock.",
        3,
      );
    for (const migration of plan.migrations) session.validateReconciliation(migration.up);
    const history = await session.history();
    const live = await session.capture();
    if (
      history.applied.length ||
      history.attempts.length ||
      digest(history) !== plan.historyHash ||
      digest(live) !== plan.catalogHash
    )
      throw new MigrationError(
        "MIGRATION_BASELINE_STALE",
        "Baseline requires untouched native history and unchanged live evidence.",
        3,
      );
    const expected = plan.expected[plan.migrations.at(-1)!.id];
    if (!expected || catalogChanges(expected, live).length)
      throw new MigrationError(
        "MIGRATION_BASELINE_DRIFT",
        "Live schema does not match independently replayed baseline.",
        3,
      );
    await runChecks(session, plan.checks, {}, "beforeBatch");
    await runChecks(session, plan.checks, plan.migrations.at(-1)!.checks, "afterUp");
    await session.bootstrap();
    await session.begin();
    try {
      let next: MigrationHistory = history;
      for (const migration of plan.migrations) {
        const attemptId = randomUUID();
        const applied: AppliedMigration = {
          id: migration.id,
          hash: migration.hash,
          catalog: plan.expected[migration.id]!,
          direction: "up",
          attemptId,
          origin: "baseline",
        };
        next = {
          ...next,
          applied: [...next.applied, applied],
          attempts: [
            ...next.attempts,
            {
              id: attemptId,
              migrationId: migration.id,
              hash: migration.hash,
              direction: "up",
              state: "applied",
              reason: options.reason,
            },
          ],
        };
      }
      await session.saveHistory(next);
      await session.commit();
      return next;
    } catch {
      await session.rollback().catch(() => undefined);
      throw new MigrationError(
        "MIGRATION_BASELINE_FAILED",
        "Baseline outcome requires history inspection before retry.",
        4,
      );
    }
  } finally {
    await session.unlock().catch(() => undefined);
    await session.close();
  }
}
/** Resolution is an operator attestation bound to exact observed state; it never executes repair SQL. */
export async function resolveAttempt(options: {
  readonly config: MigrationsConfig;
  readonly target: string;
  readonly evidence: unknown;
  readonly action: "confirm-applied" | "confirm-not-applied";
  readonly reason: string;
}): Promise<MigrationHistory> {
  const evidence = object(options.evidence, "Resolution evidence");
  if (
    !options.reason.trim() ||
    typeof evidence.attemptId !== "string" ||
    typeof evidence.migrationId !== "string" ||
    typeof evidence.hash !== "string" ||
    typeof evidence.historyHash !== "string" ||
    typeof evidence.catalogHash !== "string"
  )
    throw new MigrationError(
      "MIGRATION_RESOLUTION",
      "Resolution requires exact attempt, migration, content/history/catalog hashes and an operator reason.",
    );
  const target = options.config.targets[options.target];
  if (!target) throw new MigrationError("MIGRATION_TARGET", "Select a configured target.", 2);
  const session = await target.connect();
  try {
    const identity = await session.identity();
    assertTarget(identity, target);
    if (digest(identity) !== evidence.targetHash)
      throw new MigrationError("MIGRATION_TARGET", "Resolution evidence belongs to another target.", 3);
    await session.lock(options.config.policy?.lockTimeoutMs ?? 10000);
    const history = await session.history(),
      live = await session.capture();
    if (digest(history) !== evidence.historyHash || digest(live) !== evidence.catalogHash)
      throw new MigrationError("MIGRATION_RESOLUTION_STALE", "History or live catalog changed after inspection.", 3);
    const attempt = history.attempts.find(
      (a) => a.id === evidence.attemptId && a.migrationId === evidence.migrationId && a.hash === evidence.hash,
    );
    if (!attempt || !["unknown", "running"].includes(attempt.state))
      throw new MigrationError(
        "MIGRATION_RESOLUTION_STATE",
        "Only an unresolved running/unknown attempt can be resolved.",
        3,
      );
    if (history.applied.some((a) => a.attemptId === attempt.id))
      throw new MigrationError(
        "MIGRATION_RESOLUTION_STATE",
        "Durable applied evidence already exists; do not rewrite the successful record.",
        3,
      );
    const expected = options.action === "confirm-applied" ? attempt.expectedCatalog : attempt.beforeCatalog;
    if (expected === undefined)
      throw new MigrationError(
        "MIGRATION_RESOLUTION_EVIDENCE",
        "This attempt lacks immutable before/after catalog evidence; obtain a separately reviewed recovery plan.",
      );
    if (catalogChanges(expected, live).length)
      throw new MigrationError("MIGRATION_RESOLUTION_DRIFT", "Inspection evidence does not match the live catalog.", 3);
    if (evidence.effectsVerified !== true)
      throw new MigrationError(
        "MIGRATION_RESOLUTION_EVIDENCE",
        "Explicit inspection of complete effects or their absence is required; schema equality alone does not prove data effects.",
      );
    const next: MigrationHistory = {
      ...history,
      applied:
        options.action === "confirm-applied"
          ? [
              ...history.applied,
              {
                id: attempt.migrationId,
                hash: attempt.hash,
                catalog: expected,
                direction: attempt.direction,
                attemptId: attempt.id,
                origin: "reconciled",
              },
            ]
          : history.applied,
      attempts: history.attempts.map((a) =>
        a.id === attempt.id ? { ...a, state: "resolved", resolution: options.action, reason: options.reason } : a,
      ),
    };
    if (options.action === "confirm-applied" && attempt.direction === "down")
      throw new MigrationError(
        "MIGRATION_RESOLUTION_DOWN",
        "Down outcome requires a reviewed direction-specific recovery plan; cannot append an up identity.",
      );
    await session.begin();
    try {
      await session.saveHistory(next);
      await session.commit();
    } catch {
      await session.rollback().catch(() => undefined);
      throw new MigrationError("MIGRATION_RESOLUTION_UNKNOWN", "Resolution outcome requires inspection.", 4);
    }
    return next;
  } finally {
    await session.unlock().catch(() => undefined);
    await session.close();
  }
}
