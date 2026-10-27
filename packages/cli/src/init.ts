import { applyInitPlan, recoverInit } from "./init-apply.js";
import { installInitDependencies } from "./init-install.js";
import { planInit } from "./init-plan.js";
import { verifyInitServer } from "./init-verify.js";

export async function runInit(options: Readonly<Record<string, string>>, version: string): Promise<unknown> {
  const { apply, install, verify, recover, "allow-scripts": scripts, ...planning } = options;
  for (const [name, value] of Object.entries({ apply, install, verify, recover, "allow-scripts": scripts }))
    if (value !== undefined && value !== "true") throw new Error(`--${name} does not accept a value`);
  if (recover !== undefined) {
    if (Object.keys(options).some((key) => !["recover", "cwd", "json"].includes(key)))
      throw new Error("--recover accepts only --cwd and --json");
    if (options.json !== undefined && options.json !== "true") throw new Error("--json does not accept a value");
    return recoverInit(options.cwd ?? process.cwd());
  }
  if (options["dry-run"] !== undefined && (apply !== undefined || install !== undefined || verify !== undefined))
    throw new Error("--dry-run cannot apply, install, or verify");
  if ((install !== undefined || verify !== undefined) && apply === undefined)
    throw new Error("--install and --verify require --apply");
  if (scripts !== undefined && install === undefined) throw new Error("--allow-scripts requires --install");
  const plan = await planInit(planning, version);
  if (verify !== undefined && plan.editor === "none") throw new Error("--verify requires --editor vscode or zed");
  if (apply === undefined) return plan;
  const applied = await applyInitPlan(plan);
  let state: "config-written" | "installed" | "server-ready" = applied.state;
  try {
    if (install !== undefined) {
      await installInitDependencies(plan, scripts !== undefined);
      state = "installed";
    }
    if (verify !== undefined) {
      await verifyInitServer(plan.root);
      state = "server-ready";
    }
  } catch (error) {
    throw new Error(
      `Setup reached ${state}. Project files and the recovery journal remain available. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return {
    ...applied,
    state,
    hostVerified: false,
    lifecycleScriptsAllowed: scripts !== undefined,
    pending:
      state === "config-written"
        ? plan.pending
        : plan.pending.filter((item) => !item.startsWith("Install the listed dependencies")),
    warnings: plan.warnings,
  };
}
