import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { MigrationError, type MigrationsConfig } from "@typed-sql/migrations";
import { type ParseError, parse } from "jsonc-parser";

async function jsonConfig(file: string): Promise<Record<string, unknown>> {
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new MigrationError("MIGRATION_POLICY", "Configuration JSON exceeds 1 MiB.", 2);
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || typeof value !== "object" || value === null || Array.isArray(value))
    throw new MigrationError("MIGRATION_POLICY", "Invalid JSONC policy/project configuration.", 2);
  return value as Record<string, unknown>;
}
async function policyReference(file: string, seen = new Set<string>()): Promise<string | undefined> {
  if (seen.has(file) || seen.size >= 32)
    throw new MigrationError("MIGRATION_POLICY_CYCLE", "Cyclic or excessive tsconfig inheritance.", 2);
  const nextSeen = new Set([...seen, file]);
  const record = await jsonConfig(file);
  const inherited: string[] = [];
  const parents = record.extends === undefined ? [] : Array.isArray(record.extends) ? record.extends : [record.extends];
  for (const parent of parents) {
    if (typeof parent !== "string")
      throw new MigrationError("MIGRATION_POLICY", "tsconfig extends must contain paths.", 2);
    const path =
      parent.startsWith(".") || isAbsolute(parent)
        ? resolve(dirname(file), parent)
        : createRequire(file).resolve(parent);
    const policy = await policyReference(path, nextSeen);
    if (policy !== undefined) inherited.push(policy);
  }
  const root = record.typedSql;
  const migrations = typeof root === "object" && root !== null && "migrations" in root ? root.migrations : undefined;
  const declared =
    typeof migrations === "object" && migrations !== null && "policyFile" in migrations
      ? migrations.policyFile
      : undefined;
  if (declared !== undefined) {
    if (typeof declared !== "string" || !declared)
      throw new MigrationError("MIGRATION_POLICY", "typedSql.migrations.policyFile must be a relative path.", 2);
    return resolve(dirname(file), declared);
  }
  if (new Set(inherited).size > 1)
    throw new MigrationError(
      "MIGRATION_POLICY_CONFLICT",
      "Inherited tsconfigs select conflicting migration policy files.",
      2,
    );
  return inherited[0];
}
/** Reads static project policy only. Connections and executable factories remain in typed-sql.config.ts. */
export async function loadMigrationPolicy(options: {
  readonly root: string;
  readonly config: MigrationsConfig;
  readonly projects?: readonly string[];
  readonly project?: string;
}): Promise<MigrationsConfig> {
  const references: string[] = [];
  for (const project of options.project === undefined ? (options.projects ?? []) : [options.project]) {
    const reference = await policyReference(resolve(options.root, project));
    if (reference !== undefined) references.push(reference);
  }
  if (options.config.policyFile !== undefined) references.push(resolve(options.root, options.config.policyFile));
  const selected = [...new Set(references)];
  if (selected.length > 1 || (selected.length && options.config.policy !== undefined))
    throw new MigrationError(
      "MIGRATION_POLICY_CONFLICT",
      "Select one inline migration policy or one policy file; conflicting declarations are blocked.",
      2,
    );
  if (!selected.length) return options.config;
  const policy = await jsonConfig(selected[0]!);
  const allowed = ["drift", "unknownEvidence", "lockTimeoutMs", "managedNamespaces", "authoring", "reconciliation"];
  if (
    Object.keys(policy).some((k) => !allowed.includes(k)) ||
    (policy.drift !== undefined && policy.drift !== "block") ||
    (policy.unknownEvidence !== undefined && policy.unknownEvidence !== "block") ||
    (policy.reconciliation !== undefined && policy.reconciliation !== "explicit-evidence") ||
    (policy.authoring !== undefined && policy.authoring !== "require-current-schema-when-connected") ||
    (policy.lockTimeoutMs !== undefined &&
      (!Number.isSafeInteger(policy.lockTimeoutMs) || Number(policy.lockTimeoutMs) < 1)) ||
    (policy.managedNamespaces !== undefined &&
      (!Array.isArray(policy.managedNamespaces) ||
        policy.managedNamespaces.some((ns) => typeof ns !== "string" || !ns)))
  )
    throw new MigrationError(
      "MIGRATION_POLICY",
      "Invalid migration policy or attempted weakening of required blocking gates.",
      2,
    );
  return { ...options.config, policy: policy as NonNullable<MigrationsConfig["policy"]> };
}
