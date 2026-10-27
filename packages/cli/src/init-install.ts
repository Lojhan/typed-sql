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
  const npmScript = process.env.npm_execpath;
  const matchingScript =
    npmScript !== undefined &&
    /\.(?:c|m)?js$/u.test(npmScript) &&
    (plan.packageManager === "pnpm"
      ? /pnpm/iu.test(npmScript)
      : plan.packageManager === "npm"
        ? /npm-cli/iu.test(npmScript)
        : plan.packageManager === "yarn"
          ? /yarn/iu.test(npmScript)
          : false);
  const command = matchingScript
    ? process.execPath
    : process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : plan.packageManager;
  // The Windows command is made entirely from fixed, validated manager names
  // and flags. No project paths, package names, or user text enter cmd syntax.
  const commandArgs = matchingScript
    ? [npmScript!, ...args]
    : process.platform === "win32"
      ? ["/d", "/s", "/c", [plan.packageManager, ...args].join(" ")]
      : args;
  await execFile(command, commandArgs, { cwd: plan.root, env, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
}
