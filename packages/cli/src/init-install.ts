import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import type { InitPlan } from "./init-plan.js";

const execFile = promisify(callback);

export async function installInitDependencies(plan: InitPlan, allowScripts: boolean): Promise<void> {
  const args = ["install", ...(allowScripts || plan.packageManager === "yarn" ? [] : ["--ignore-scripts"])];
  const env = {
    ...process.env,
    ...(allowScripts ? {} : { YARN_ENABLE_SCRIPTS: "false", YARN_IGNORE_SCRIPTS: "true" }),
  };
  // Never execute npm_execpath or ComSpec supplied by the caller's environment.
  const manager =
    plan.packageManager === "pnpm"
      ? "pnpm"
      : plan.packageManager === "npm"
        ? "npm"
        : plan.packageManager === "yarn"
          ? "yarn"
          : plan.packageManager === "bun"
            ? "bun"
            : undefined;
  if (manager === undefined) throw new Error("Unsupported package manager");
  const command = process.platform === "win32" ? "cmd.exe" : manager;
  // Only fixed manager names and flags enter Windows command syntax.
  const commandArgs = process.platform === "win32" ? ["/d", "/v:off", "/s", "/c", [manager, ...args].join(" ")] : args;
  await execFile(command, commandArgs, { cwd: plan.root, env, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
}
