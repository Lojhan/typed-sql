import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const options = { grammar: undefined, probe: undefined, databaseVersion: undefined, fixtureGroup: undefined };
const cliArgs = process.argv.slice(2).filter((argument) => argument !== "--");

for (let index = 0; index < cliArgs.length; index += 1) {
  const argument = cliArgs[index];
  if (argument === "--help") {
    console.log(
      "usage: pnpm conformance:v2 -- [--grammar postgres|mysql|sqlite|synthetic] [--probe ID] [--database-version VERSION] [--fixture-group GROUP]",
    );
    process.exit(0);
  }
  const key = {
    "--grammar": "grammar",
    "--probe": "probe",
    "--database-version": "databaseVersion",
    "--fixture-group": "fixtureGroup",
  }[argument];
  if (key === undefined) throw new TypeError(`Unknown conformance option ${JSON.stringify(argument)}`);
  const value = cliArgs[index + 1];
  if (value === undefined || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
  options[key] = value;
  index += 1;
}

const grammars = new Set(["postgres", "mysql", "sqlite", "synthetic"]);
if (options.grammar !== undefined && !grammars.has(options.grammar)) {
  throw new TypeError(`Unsupported conformance grammar ${JSON.stringify(options.grammar)}`);
}
if (options.probe !== undefined && options.grammar === undefined) {
  throw new TypeError("--probe requires --grammar");
}
if (options.databaseVersion !== undefined && options.grammar === undefined) {
  throw new TypeError("--database-version requires --grammar");
}
if (options.fixtureGroup !== undefined && !new Set(["legacy", "statement.select"]).has(options.fixtureGroup)) {
  throw new TypeError(`Unsupported conformance fixture group ${JSON.stringify(options.fixtureGroup)}`);
}

const environment = {
  ...process.env,
  ...(options.probe === undefined ? {} : { TYPED_SQL_CONFORMANCE_PROBE: options.probe }),
  ...(options.databaseVersion === undefined ? {} : { TYPED_SQL_CONFORMANCE_DATABASE_VERSION: options.databaseVersion }),
  ...(options.fixtureGroup === undefined ? {} : { TYPED_SQL_CONFORMANCE_FIXTURE_GROUP: options.fixtureGroup }),
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

await run(pnpm, ["build"]);

if (options.databaseVersion !== undefined) {
  if (options.grammar === "postgres") await run(pnpm, ["--filter", "@typed-sql/e2e-postgres", "e2e"]);
  else if (options.grammar === "mysql") await run(pnpm, ["--filter", "@typed-sql/e2e-mysql", "e2e"]);
  else if (options.grammar === "sqlite") await run(process.execPath, ["examples/e2e.mjs", "sqlite"]);
  else throw new TypeError("Live conformance is available for postgres, mysql, and sqlite");
} else if (options.grammar === "synthetic") {
  await run(pnpm, ["--filter", "@typed-sql/example-synthetic-grammar", "test"]);
} else if (options.grammar === "sqlite") {
  await run(pnpm, ["--filter", "@typed-sql/sqlite", "test"]);
} else if (options.grammar === "postgres" || options.grammar === "mysql") {
  await run(pnpm, ["--filter", "@typed-sql/conformance", "test"]);
} else {
  await run(pnpm, ["--filter", "@typed-sql/conformance", "test"]);
  await run(pnpm, ["--filter", "@typed-sql/sqlite", "test"]);
  await run(pnpm, ["--filter", "@typed-sql/example-synthetic-grammar", "test"]);
}
