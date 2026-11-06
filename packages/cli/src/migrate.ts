import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig } from "@typed-sql/config";
import {
  applyPlan,
  baselinePlan,
  createMigration,
  createPlan,
  ensureDirectory,
  inspectMigrations,
  MigrationError,
  type MigrationPlan,
  type MigrationsConfig,
  migrationPlanReport,
  parsePlan,
  resolveAttempt,
  safePath,
} from "@typed-sql/migrations";
import { writeMigrationOutput } from "./migration-output.js";
import { loadMigrationPolicy } from "./migration-policy.js";
import { verifyMigrationCompatibility } from "./migration-verify.js";

const usage = `Usage: typed-sql migrate <command> [options]

Commands:
  init [--apply]                   Preview/create the migration directory
  new <name> [--format sql|ts]      Create an immutable migration entry
  verify --before-through <id|empty> Replay and verify both application revisions
  status | validate | drift        Inspect history and blocking schema drift
  plan [--out plan.json]           Replay independently and capture reviewed operations
  apply [--plan plan.json]         Apply pending up operations under the database lock
  revert --to <id|empty>           Apply declared down operations in reverse order
  reconcile plan|apply            Adopt one independently verified manual schema change
  baseline --evidence plan.json    Adopt an independently replayed initial prefix
  resolve --evidence evidence.json Inspect and resolve an uncertain attempt explicitly

Options: --config <file> --target <alias> --to <id> --json --yes
Plan: --out <file>; apply/revert: --plan <file>
Recovery: --reason <text>; resolve: --action confirm-applied|confirm-not-applied
All database commands require an explicit target. No command provisions, resets or drops a database.
`;
function parse(args: readonly string[]): {
  command: string;
  subcommand: string | undefined;
  positional: string | undefined;
  flags: Record<string, string>;
} {
  const command = args[0] ?? "help";
  let subcommand: string | undefined;
  let positional: string | undefined;
  const flags: Record<string, string> = {};
  const boolean = new Set(["apply", "json", "yes", "help"]);
  const values = new Set([
    "config",
    "target",
    "to",
    "out",
    "plan",
    "format",
    "reason",
    "evidence",
    "through",
    "action",
    "id",
    "attempt",
    "direction",
    "project",
    "before",
    "after",
    "before-manifest",
    "after-manifest",
    "before-through",
    "capture-dir",
    "fail-on",
  ]);
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      if (command === "reconcile" && subcommand === undefined) subcommand = arg;
      else if (command === "new" && positional === undefined) positional = arg;
      else throw new MigrationError("MIGRATION_USAGE", `Unexpected argument ${arg}.`, 2);
      continue;
    }
    const equals = arg.indexOf("=");
    const key = arg.slice(2, equals === -1 ? undefined : equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    if (!key || (!boolean.has(key) && !values.has(key)))
      throw new MigrationError("MIGRATION_USAGE", `Unknown migration option ${arg}.`, 2);
    if (key in flags) throw new MigrationError("MIGRATION_USAGE", `Duplicate migration option --${key}.`, 2);
    if (boolean.has(key)) {
      if (inline !== undefined) throw new MigrationError("MIGRATION_USAGE", `--${key} does not accept a value.`, 2);
      flags[key] = "true";
    } else {
      const value = inline ?? args[++index];
      if (value === undefined || value.startsWith("--"))
        throw new MigrationError("MIGRATION_USAGE", `Missing --${key} value.`, 2);
      flags[key] = value;
    }
  }
  return { command, subcommand, positional, flags };
}
function configValue(value: unknown): MigrationsConfig {
  if (
    typeof value !== "object" ||
    value === null ||
    !("directory" in value) ||
    typeof value.directory !== "string" ||
    !("targets" in value) ||
    typeof value.targets !== "object" ||
    value.targets === null
  )
    throw new MigrationError(
      "MIGRATION_CONFIG",
      "Configure migrations with defineMigrations({ directory, targets, replayTarget }) in typed-sql.config.ts. Connection factories must be explicit and lazy.",
      2,
    );
  const config = value as MigrationsConfig;
  if (
    (config.defaultFormat !== undefined && !["sql", "ts"].includes(config.defaultFormat)) ||
    (config.templateDirectory !== undefined && typeof config.templateDirectory !== "string")
  )
    throw new MigrationError("MIGRATION_CONFIG", "Invalid migration defaultFormat or templateDirectory.", 2);
  for (const target of Object.values(config.targets))
    if (
      !target ||
      typeof target.connect !== "function" ||
      typeof target.expected?.database !== "string" ||
      !["development", "test", "production"].includes(target.classification)
    )
      throw new MigrationError(
        "MIGRATION_CONFIG",
        "Migration targets require connect(), expected.database and explicit classification.",
        2,
      );
  if (
    (config.policy?.drift !== undefined && config.policy.drift !== "block") ||
    (config.policy?.unknownEvidence !== undefined && config.policy.unknownEvidence !== "block")
  )
    throw new MigrationError("MIGRATION_POLICY", "Required drift and unknown-evidence gates cannot be disabled.", 2);
  return config;
}
async function readPlan(root: string, path: string): Promise<MigrationPlan> {
  return parsePlan(JSON.parse(await readFile(await safePath(root, path), "utf8")));
}
async function writePlan(root: string, path: string, plan: MigrationPlan): Promise<string> {
  const file = resolve(root, path);
  await ensureDirectory(root, dirname(file));
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return file;
}
export async function runMigrationCli(args: readonly string[]): Promise<void> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage);
    return;
  }
  let json = args.includes("--json");
  try {
    const { command, subcommand, positional, flags } = parse(args);
    json = flags.json !== undefined;
    if (command === "help" || flags.help !== undefined) {
      process.stdout.write(usage);
      return;
    }
    if (
      ![
        "init",
        "new",
        "status",
        "validate",
        "drift",
        "plan",
        "apply",
        "revert",
        "reconcile",
        "baseline",
        "resolve",
        "verify",
      ].includes(command)
    )
      throw new MigrationError("MIGRATION_USAGE", `Unknown migration command ${command}.`, 2);
    const common = ["config", "target", "json", "help", "project"];
    const specific: Readonly<Record<string, readonly string[]>> = {
      init: ["apply"],
      new: ["format"],
      status: [],
      validate: [],
      drift: [],
      plan: ["to", "out", "direction"],
      apply: ["plan", "to", "yes"],
      revert: ["plan", "to", "yes"],
      reconcile: subcommand === "plan" ? ["to", "out"] : ["plan", "reason", "yes"],
      baseline: ["through", "evidence", "reason", "yes"],
      resolve: ["id", "attempt", "evidence", "action", "reason", "yes"],
      verify: [
        "before",
        "after",
        "before-manifest",
        "after-manifest",
        "before-through",
        "to",
        "out",
        "fail-on",
        "capture-dir",
      ],
    };
    for (const flag of Object.keys(flags))
      if (!common.includes(flag) && !specific[command]!.includes(flag))
        throw new MigrationError("MIGRATION_USAGE", `--${flag} is not supported by migrate ${command}.`, 2);
    const loaded = await loadConfig({ ...(flags.config === undefined ? {} : { file: flags.config }) });
    const root = loaded.directory;
    if (command === "init") {
      const directory =
        typeof loaded.config.migrations === "object" &&
        loaded.config.migrations !== null &&
        "directory" in loaded.config.migrations &&
        typeof loaded.config.migrations.directory === "string"
          ? loaded.config.migrations.directory
          : "migrations";
      const path = resolve(root, directory);
      if (flags.apply !== undefined) await ensureDirectory(root, path);
      writeMigrationOutput(
        {
          formatVersion: 1,
          command: "init",
          state: flags.apply === undefined ? "preview" : "created",
          directory,
          next: "Configure explicit migration targets and replayTarget using defineMigrations; then migrate new <name>.",
        },
        json,
      );
      return;
    }
    const config = await loadMigrationPolicy({
      root,
      config: configValue(loaded.config.migrations),
      ...(loaded.config.projects === undefined ? {} : { projects: loaded.config.projects }),
      ...(flags.project === undefined ? {} : { project: flags.project }),
    });
    if (command === "new") {
      if (flags.target !== undefined) {
        const status = await inspectMigrations({ root, config, renderer: loaded.config.dialect, target: flags.target });
        if (status.drift.length || status.diagnostics.length || status.driftState === "unknown")
          throw new MigrationError(
            "MIGRATION_DRIFT",
            "Schema drift blocks connected migration authoring. Reconcile or remove the manual change first.",
            3,
          );
      }
      if (!positional) throw new MigrationError("MIGRATION_USAGE", "migrate new requires a name.", 2);
      if (flags.format !== undefined && !["sql", "ts"].includes(flags.format))
        throw new MigrationError("MIGRATION_USAGE", "--format must be sql or ts.", 2);
      const file = await createMigration(
        root,
        config.directory,
        positional,
        (flags.format ?? config.defaultFormat) as "sql" | "ts" | undefined,
        loaded.config.dialect.sqlModule,
        config.templateDirectory,
      );
      writeMigrationOutput(
        {
          formatVersion: 1,
          state: "created",
          file,
          verification: "offline-unverified",
          next: "Run migrate plan --target <alias> before applying.",
        },
        json,
      );
      return;
    }
    const target = flags.target;
    if (!target || !config.targets[target])
      throw new MigrationError("MIGRATION_TARGET", "Database commands require --target <configured alias>.", 2);
    if (flags.direction !== undefined && !["up", "down"].includes(flags.direction))
      throw new MigrationError("MIGRATION_USAGE", "--direction must be up or down.", 2);
    const options = {
      root,
      config,
      renderer: loaded.config.dialect,
      target,
      ...(flags.to === undefined ? {} : { to: flags.to }),
    };
    const write = (value: unknown) => writeMigrationOutput(value, json);
    if (command === "verify") {
      write(await verifyMigrationCompatibility({ loaded, migrations: config, target, flags }));
      return;
    }
    if (["status", "validate", "drift"].includes(command)) {
      const status = await inspectMigrations(options);
      write({ formatVersion: 1, kind: "typed-sql-migration-status", ...status });
      if (command !== "status" && (status.drift.length || status.diagnostics.length || status.driftState === "unknown"))
        process.exitCode = 1;
      return;
    }
    if (command === "plan" || (command === "reconcile" && subcommand === "plan")) {
      const plan = await createPlan({
        ...options,
        ...(flags.direction === "down" ? { direction: "down" as const } : {}),
        ...(command === "reconcile" ? { reconcile: true } : {}),
      });
      const bundle = flags.out === undefined ? undefined : await writePlan(root, flags.out, plan);
      write({ ...(migrationPlanReport(plan) as Record<string, unknown>), ...(bundle === undefined ? {} : { bundle }) });
      return;
    }
    if (config.targets[target]!.classification === "production" && flags.yes === undefined)
      throw new MigrationError(
        "MIGRATION_CONFIRM_TARGET",
        "Production execution requires explicit --yes for the displayed target alias.",
        2,
      );
    if (command === "apply" || command === "revert" || (command === "reconcile" && subcommand === "apply")) {
      if (command === "reconcile" && (!flags.plan || !flags.reason))
        throw new MigrationError("MIGRATION_RECONCILE", "Reconciliation apply requires --plan and --reason.", 2);
      if (command === "revert" && (!flags.to || !flags.plan))
        throw new MigrationError(
          "MIGRATION_REVERT",
          "Revert requires --to and a reviewed down --plan; create it using migrate plan --direction down.",
          2,
        );
      const plan = flags.plan === undefined ? await createPlan(options) : await readPlan(root, flags.plan);
      if (command === "apply" && plan.direction !== "up")
        throw new MigrationError("MIGRATION_DIRECTION", "Use migrate revert for a down plan.", 2);
      if (flags.to !== undefined && plan.boundary !== flags.to)
        throw new MigrationError("MIGRATION_BOUNDARY", "Reviewed plan does not match the requested --to boundary.", 3);
      if (command === "revert" && plan.direction !== "down")
        throw new MigrationError("MIGRATION_REVERT", "Revert requires a down-direction plan.", 2);
      const result = await applyPlan({
        ...options,
        plan,
        ...(command === "reconcile" ? { reconcile: true, reason: flags.reason! } : {}),
      });
      write({
        formatVersion: 1,
        state: "applied",
        migrations: result.applied,
        findings: result.findings,
        next: "Run typed-sql generate and typed-sql check; database execution and generation are separate outcomes.",
      });
      return;
    }
    if (command === "baseline") {
      if (!flags.evidence || !flags.reason || !flags.through)
        throw new MigrationError(
          "MIGRATION_BASELINE",
          "Baseline requires --through, --evidence <replayed plan> and --reason.",
          2,
        );
      const plan = await readPlan(root, flags.evidence);
      if (plan.migrations.at(-1)?.id !== flags.through)
        throw new MigrationError("MIGRATION_BASELINE", "Evidence does not match the requested baseline prefix.", 3);
      const result = await baselinePlan({
        root,
        config,
        target,
        plan,
        reason: flags.reason,
        renderer: loaded.config.dialect,
      });
      write({
        formatVersion: 1,
        state: "baselined",
        migrations: result.history.applied.map((m) => m.id),
        findings: result.findings,
      });
      return;
    }
    if (command === "resolve") {
      if (!flags.evidence || !flags.reason || !["confirm-applied", "confirm-not-applied"].includes(flags.action ?? ""))
        throw new MigrationError(
          "MIGRATION_RESOLUTION",
          "Resolve requires --evidence, --reason and --action confirm-applied|confirm-not-applied.",
          2,
        );
      const evidence = JSON.parse(await readFile(await safePath(root, flags.evidence), "utf8")) as Record<
        string,
        unknown
      >;
      if (
        (flags.id !== undefined && evidence.migrationId !== flags.id) ||
        (flags.attempt !== undefined && evidence.attemptId !== flags.attempt)
      )
        throw new MigrationError("MIGRATION_RESOLUTION", "Evidence does not match requested migration/attempt.", 3);
      await resolveAttempt({
        config,
        target,
        evidence,
        action: flags.action as "confirm-applied" | "confirm-not-applied",
        reason: flags.reason,
      });
      write({ formatVersion: 1, state: "resolved", next: "Inspect status and create a new plan; no SQL was retried." });
      return;
    }
    throw new MigrationError("MIGRATION_USAGE", "Use reconcile plan or reconcile apply.", 2);
  } catch (error) {
    const failure =
      error instanceof MigrationError
        ? error
        : new MigrationError(
            "MIGRATION_COMMAND_FAILED",
            "Migration command failed. Inspect configuration, file permissions and local database logs; connection details are omitted.",
          );
    if (json)
      process.stdout.write(
        `${JSON.stringify({ formatVersion: 1, state: "blocked", code: failure.code, message: failure.message, ...(failure.findings === undefined ? {} : { findings: failure.findings }) })}\n`,
      );
    else {
      process.stderr.write(`${failure.code}: ${failure.message}\n`);
      for (const finding of failure.findings ?? [])
        if (finding.severity === "warning" && finding.status !== "passed")
          process.stderr.write(`warning ${finding.id} (${finding.status}): ${finding.message}\n`);
    }
    process.exitCode = failure.exitCode;
  }
}
