import type { PlaygroundConfiguration } from "@typed-sql/core";
import { WorkspaceError } from "./files.js";

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WorkspaceError("CONFIG", `${name} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], name: string) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new WorkspaceError("CONFIG", `Unknown ${name} option ${key}`);
}

/** Executable mjs/js configurations receive the same validation as typed TS configs. No factory is called here. */
export function validatePlaygroundConfiguration(value: unknown): asserts value is PlaygroundConfiguration | undefined {
  if (value === undefined) return;
  const config = object(value, "playground");
  keys(config, ["projects", "readRoots", "writeRoots", "scratchDirectory", "targets", "limits"], "playground");
  for (const name of ["projects", "readRoots", "writeRoots"]) {
    const entries = config[name];
    if (
      entries !== undefined &&
      (!Array.isArray(entries) ||
        entries.length > 64 ||
        entries.some((entry) => typeof entry !== "string" || !entry || entry.includes("\0")))
    )
      throw new WorkspaceError("CONFIG", `playground.${name} must be an array of at most 64 nonempty paths`);
  }
  if (
    config.scratchDirectory !== undefined &&
    (typeof config.scratchDirectory !== "string" || !config.scratchDirectory)
  )
    throw new WorkspaceError("CONFIG", "playground.scratchDirectory must be a nonempty path");
  if (config.limits !== undefined) {
    const limits = object(config.limits, "playground.limits");
    keys(
      limits,
      ["timeoutMs", "maxRows", "pageSize", "maxSpoolBytes", "cursorIdleMs", "maxResultBytes", "maxConsoleBytes"],
      "playground.limits",
    );
    for (const [name, limit] of Object.entries(limits))
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)
        throw new WorkspaceError("CONFIG", `playground.limits.${name} must be a positive integer`);
  }
  if (config.targets !== undefined) {
    const targets = object(config.targets, "playground.targets");
    for (const [alias, value] of Object.entries(targets)) {
      if (!alias || alias.length > 100 || alias.includes("\0"))
        throw new WorkspaceError("CONFIG", "Target aliases must be nonempty names of at most 100 characters");
      const target = object(value, `playground.targets.${alias}`);
      keys(target, ["classification", "expected", "connect"], `playground.targets.${alias}`);
      if (!["development", "test", "production"].includes(String(target.classification)))
        throw new WorkspaceError(
          "CONFIG",
          `playground.targets.${alias}.classification must be development, test, or production`,
        );
      if (typeof target.connect !== "function")
        throw new WorkspaceError("CONFIG", `playground.targets.${alias}.connect must be a lazy function`);
      if (target.expected !== undefined) {
        const expected = object(target.expected, `playground.targets.${alias}.expected`);
        keys(expected, ["database"], `playground.targets.${alias}.expected`);
        if (typeof expected.database !== "string" || !expected.database || expected.database.includes("\0"))
          throw new WorkspaceError("CONFIG", `playground.targets.${alias}.expected.database must be a nonempty string`);
      }
    }
  }
}
