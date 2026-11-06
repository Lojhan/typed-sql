import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const options = { grammar: undefined, probe: undefined, databaseVersion: undefined, fixtureGroup: undefined };
const cliArgs = process.argv.slice(2).filter((argument) => argument !== "--");

for (let index = 0; index < cliArgs.length; index += 1) {
  const argument = cliArgs[index];
  if (argument === "--help") {
    console.log(
      "usage: pnpm conformance:v2 -- [--grammar postgres|mysql|sqlite|sqlserver|duckdb|synthetic] [--probe ID] [--database-version VERSION] [--fixture-group legacy|statement.select|native]",
    );
    console.log(
      "SQL Server and DuckDB run static maintainer probes by default. --database-version selects a complete native qualification shard and cannot be combined with probe filters.",
    );
    console.log(
      "SQL Server live qualification requires its configured disposable Linux x64 environment; DuckDB qualifies exact engines 1.5.6 and 2.0.0.",
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

const grammars = new Set(["postgres", "mysql", "sqlite", "sqlserver", "duckdb", "synthetic"]);
if (options.grammar !== undefined && !grammars.has(options.grammar)) {
  throw new TypeError(`Unsupported conformance grammar ${JSON.stringify(options.grammar)}`);
}
if (options.probe !== undefined && options.grammar === undefined) {
  throw new TypeError("--probe requires --grammar");
}
if (options.databaseVersion !== undefined && options.grammar === undefined) {
  throw new TypeError("--database-version requires --grammar");
}
if (
  options.fixtureGroup !== undefined &&
  !new Set(["legacy", "statement.select", "native"]).has(options.fixtureGroup)
) {
  throw new TypeError(`Unsupported conformance fixture group ${JSON.stringify(options.fixtureGroup)}`);
}

const nativeGrammar = options.grammar === "sqlserver" || options.grammar === "duckdb";
if (options.fixtureGroup === "native" && !nativeGrammar)
  throw new TypeError("The native fixture group requires sqlserver or duckdb");
if (nativeGrammar && options.fixtureGroup === "legacy")
  throw new TypeError("Native grammars have no legacy fixture group");
if (nativeGrammar && options.databaseVersion !== undefined) {
  if (options.probe !== undefined || options.fixtureGroup !== undefined)
    throw new TypeError(
      "Native qualification runs a complete dialect shard; use filters without --database-version for static maintainer probes",
    );
  if (options.grammar === "duckdb") {
    if (!["1.5.6", "2.0.0"].includes(options.databaseVersion))
      throw new TypeError("DuckDB qualification requires exact engine 1.5.6 or 2.0.0");
  } else {
    const major = Number(options.databaseVersion.split(".")[0]);
    const build = process.env.TYPED_SQL_SQLSERVER_BUILD;
    if (
      ![14, 15, 16, 17].includes(major) ||
      !/^(14|15|16|17)(?:\.\d+\.\d+\.\d+)?$/u.test(options.databaseVersion) ||
      process.env.TYPED_SQL_SQLSERVER_MAJOR !== String(major) ||
      !build ||
      !/^\d+\.\d+\.\d+\.\d+$/u.test(build) ||
      Number(build.split(".")[0]) !== major ||
      (options.databaseVersion.includes(".") && options.databaseVersion !== build)
    )
      throw new TypeError(
        "SQL Server live qualification requires matching TYPED_SQL_SQLSERVER_MAJOR and TYPED_SQL_SQLSERVER_BUILD from its disposable native environment",
      );
    if (!process.env.TYPED_SQL_SQLSERVER_PASSWORD || /[;{}]/u.test(process.env.TYPED_SQL_SQLSERVER_PASSWORD))
      throw new TypeError("SQL Server live qualification requires its configured disposable local password");
    if (process.platform !== "linux" || process.arch !== "x64")
      throw new TypeError("SQL Server direct ODBC qualification requires the existing Linux x64 native environment");
  }
}

const environment = {
  ...process.env,
  ...(options.probe === undefined ? {} : { TYPED_SQL_CONFORMANCE_PROBE: options.probe }),
  ...(options.databaseVersion === undefined ? {} : { TYPED_SQL_CONFORMANCE_DATABASE_VERSION: options.databaseVersion }),
  ...(options.fixtureGroup === undefined ? {} : { TYPED_SQL_CONFORMANCE_FIXTURE_GROUP: options.fixtureGroup }),
};

function run(command, args, directory = process.cwd(), artifact) {
  return new Promise((accept, reject) => {
    const output = [];
    let bytes = 0;
    const child = spawn(command, args, {
      cwd: directory,
      env: environment,
      stdio: artifact ? ["inherit", "pipe", "pipe"] : "inherit",
    });
    if (artifact)
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes <= 32 * 1024 * 1024) output.push(chunk);
        });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      void (async () => {
        if (artifact) {
          const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
          const text = Buffer.concat(output).toString("utf8");
          const redacted = password ? text.replaceAll(password, "[redacted]") : text;
          await mkdir(resolve(artifact, ".."), { recursive: true });
          await writeFile(artifact, redacted);
          process.stdout.write(redacted);
        }
        if (code === 0 && bytes <= 32 * 1024 * 1024) accept();
        else throw new Error(`${command} ${args.join(" ")} failed (${signal ?? code ?? "unknown"})`);
      })().catch(reject);
    });
  });
}

await run(pnpm, ["build"]);

if (options.databaseVersion !== undefined) {
  if (options.grammar === "postgres") await run(pnpm, ["--filter", "@typed-sql/e2e-postgres", "e2e"]);
  else if (options.grammar === "mysql") await run(pnpm, ["--filter", "@typed-sql/e2e-mysql", "e2e"]);
  else if (options.grammar === "sqlite") await run(process.execPath, ["examples/e2e.mjs", "sqlite"]);
  else if (options.grammar === "sqlserver")
    await run(
      process.execPath,
      ["--import", "tsx", "adapter-probe.mjs"],
      resolve("e2e/sqlserver"),
      resolve("artifacts/conformance", `sqlserver-live-${options.databaseVersion}.log`),
    );
  else if (options.grammar === "duckdb") {
    environment.TYPED_SQL_DUCKDB_SDK = options.databaseVersion === "1.5.6" ? "15" : "20";
    const suffix = options.databaseVersion === "1.5.6" ? "15" : "";
    const suites = [
      "analytical",
      "bulk",
      "catalog",
      "combination",
      "dml",
      "ledger-capabilities",
      "lexical",
      "namespaces",
      "provider",
      "provider-additional",
      "runtime",
      "services",
    ];
    await run(
      pnpm,
      [
        "--filter",
        "@typed-sql/duckdb",
        "exec",
        "poku",
        ...suites.map((name) => `test/${name}${suffix}.test.ts`),
        "--sequential",
        "--reporter=compact",
        "--enforce",
      ],
      process.cwd(),
      resolve("artifacts/conformance", `duckdb-live-${options.databaseVersion}.log`),
    );
  } else throw new TypeError("Select a supported live conformance grammar");
} else if (nativeGrammar) {
  await run(process.execPath, ["--import", "tsx", "scripts/native-conformance-v2.ts", options.grammar]);
} else if (options.grammar === "synthetic") {
  await run(pnpm, ["--filter", "@typed-sql/example-synthetic-grammar", "test"]);
} else if (options.grammar === "sqlite") {
  await run(pnpm, ["--filter", "@typed-sql/sqlite", "test"]);
} else if (options.grammar === "postgres" || options.grammar === "mysql") {
  await run(pnpm, ["--filter", "@typed-sql/conformance", "test"]);
} else {
  await run(pnpm, ["--filter", "@typed-sql/conformance", "test"]);
  await run(pnpm, ["--filter", "@typed-sql/sqlite", "test"]);
  for (const grammar of ["sqlserver", "duckdb"])
    await run(process.execPath, ["--import", "tsx", "scripts/native-conformance-v2.ts", grammar]);
  await run(pnpm, ["--filter", "@typed-sql/example-synthetic-grammar", "test"]);
}
