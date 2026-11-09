import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log, waitForExpectedResult, waitForPort } from "poku";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export async function startMySqlFixture() {
  const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const engine = process.env.TYPED_SQL_CONTAINER_ENGINE ?? "podman";
  const port = Number(process.env.TYPED_SQL_MYSQL_E2E_PORT ?? "53306");
  const containerName = `typed-sql-e2e-mysql-${process.pid}`;
  const matrixLabel = process.env.TYPED_SQL_MYSQL_MATRIX_LABEL ?? "mysql-8.4.11-local";
  const expectedVersion = process.env.TYPED_SQL_MYSQL_VERSION ?? "8.4.11";
  const baseImage = process.env.TYPED_SQL_MYSQL_IMAGE;
  const channel = process.env.TYPED_SQL_MYSQL_CHANNEL ?? "stable";
  const modeProfile = process.env.TYPED_SQL_MYSQL_MODE_PROFILE ?? "default";
  const sqlMode = process.env.TYPED_SQL_MYSQL_SQL_MODE;
  const imageName = `localhost/typed-sql-e2e-${matrixLabel.replaceAll(/[^a-zA-Z0-9_.-]/gu, "-").toLowerCase()}`;
  const connectionUri = `mysql://typed_sql:typed_sql_e2e@127.0.0.1:${port}/typed_sql_e2e`;
  let containerStarted = false;

  if (channel !== "stable" && channel !== "canary")
    throw new TypeError("TYPED_SQL_MYSQL_CHANNEL must be stable or canary");
  if (!new Set(["default", "lexical", "numeric"]).has(modeProfile))
    throw new TypeError("TYPED_SQL_MYSQL_MODE_PROFILE must be default, lexical, or numeric");

  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new TypeError("TYPED_SQL_MYSQL_E2E_PORT must be an unprivileged TCP port");

  function run(command: string, args: readonly string[], cwd = packageDirectory): Promise<CommandResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(command, [...args], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
    });
  }

  async function mustRun(command: string, args: readonly string[], cwd = packageDirectory): Promise<CommandResult> {
    const result = await run(command, args, cwd);
    if (result.code !== 0)
      throw new Error(`${command} ${args.join(" ")} failed (${result.code})\n${result.stdout}${result.stderr}`);
    return result;
  }

  log(`Building ${imageName} for ${matrixLabel}`);
  const buildArguments = ["build", "--tag", imageName, "--file", "Containerfile"];
  if (baseImage !== undefined) buildArguments.push("--build-arg", `MYSQL_BASE_IMAGE=${baseImage}`);
  buildArguments.push(".");
  await mustRun(engine, buildArguments);

  try {
    await mustRun(engine, [
      "run",
      "--detach",
      "--name",
      containerName,
      "--publish",
      `127.0.0.1:${port}:3306`,
      "--env",
      "MYSQL_DATABASE=typed_sql_e2e",
      "--env",
      "MYSQL_USER=typed_sql",
      "--env",
      "MYSQL_PASSWORD=typed_sql_e2e",
      "--env",
      "MYSQL_ROOT_PASSWORD=typed_sql_root",
      imageName,
      "--local-infile=ON",
      ...(sqlMode === undefined ? [] : [`--sql-mode=${sqlMode}`]),
    ]);
    containerStarted = true;
    try {
      await waitForExpectedResult(
        async () => {
          const logs = await run(engine, ["logs", containerName]);
          return `${logs.stdout}${logs.stderr}`.toLowerCase().includes("mysql init process done. ready for start up.");
        },
        true,
        { interval: 250, timeout: 90_000, strict: true },
      );
      await waitForPort(port, { host: "127.0.0.1", timeout: 90_000 });
      await waitForExpectedResult(
        async () => {
          const result = await run(engine, [
            "exec",
            containerName,
            "mysql",
            "--batch",
            "--skip-column-names",
            "--user=typed_sql",
            "--password=typed_sql_e2e",
            "typed_sql_e2e",
            "--execute=SELECT COUNT(*) FROM users",
          ]);
          return result.code === 0 ? result.stdout.trim() : "";
        },
        "2",
        { interval: 250, timeout: 90_000, strict: true },
      );
    } catch (error) {
      const state = await run(engine, ["inspect", "--format", "{{json .State}}", containerName]);
      const logs = await run(engine, ["logs", containerName]);
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `Container state: ${state.stdout}${state.stderr}`,
          `Container logs:\n${logs.stdout}${logs.stderr}`,
        ].join("\n"),
      );
    }
  } catch (error) {
    if (containerStarted) await run(engine, ["rm", "--force", containerName]);
    throw error;
  }
  return {
    engine,
    containerName,
    connectionUri,
    rootUri: `mysql://root:typed_sql_root@127.0.0.1:${port}/typed_sql_e2e`,
    port,
    expectedVersion,
    matrixLabel,
    channel,
    modeProfile,
    run,
    mustRun,
    async close() {
      if (containerStarted) {
        containerStarted = false;
        await run(engine, ["rm", "--force", containerName]);
      }
    },
  };
}
