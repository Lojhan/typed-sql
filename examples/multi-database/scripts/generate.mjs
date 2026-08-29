import { spawn } from "node:child_process";
import { resolve } from "node:path";

const directory = process.cwd();
const cli = resolve(directory, "../../packages/cli/dist/packages/cli/src/cli.js");
const tsx = resolve(directory, "node_modules/.bin/tsx");
const fromSnapshot = process.argv.includes("--snapshot");

function run(program, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(program, args, { cwd: directory, env: process.env, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${program} ${args.join(" ")} failed (${signal ?? code})`));
    });
  });
}

if (!fromSnapshot) await run(tsx, ["sqlite/setup.ts"]);

for (const database of ["postgres", "sqlite"]) {
  const args = [cli, "generate", "--config", `${database}/typed-sql.config.ts`];
  if (fromSnapshot) args.push("--snapshot", `${database}/schema/catalog.snapshot.json`);
  await run(process.execPath, args);
}
