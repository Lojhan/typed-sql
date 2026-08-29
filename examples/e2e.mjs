import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const requested = process.argv[2];
const names = requested === undefined ? ["postgres", "mysql", "sqlite"] : [requested];
const supported = new Set(["postgres", "mysql", "sqlite"]);

if (names.some((name) => !supported.has(name))) {
  throw new TypeError("usage: node examples/e2e.mjs [postgres|mysql|sqlite]");
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${args.join(" ")} failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

async function filtered(name, script) {
  await run(["--filter", `@typed-sql/example-${name}`, script]);
}

async function databaseExample(name) {
  let containerMayExist = false;
  try {
    containerMayExist = true;
    await filtered(name, "db:up");
    await filtered(name, "generate");
    await filtered(name, "check");
    await filtered(name, "test");
    await filtered(name, "start");
    await filtered(name, "test:database");
  } finally {
    if (containerMayExist) await filtered(name, "db:down").catch(() => undefined);
  }
}

async function sqliteExample() {
  await filtered("sqlite", "generate");
  await filtered("sqlite", "check");
  await filtered("sqlite", "test");
  await filtered("sqlite", "start");
  await filtered("sqlite", "test:database");
}

for (const name of names) {
  if (name === "sqlite") await sqliteExample();
  else await databaseExample(name);
}
