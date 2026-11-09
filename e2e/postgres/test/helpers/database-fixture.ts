import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log, waitForExpectedResult, waitForPort } from "poku";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function startPostgresFixture() {
  const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const engine = process.env.TYPED_SQL_CONTAINER_ENGINE ?? "podman";
  const port = Number(process.env.TYPED_SQL_E2E_PORT ?? "55432");
  const expectedVersion = process.env.TYPED_SQL_POSTGRES_VERSION ?? "18.6";
  const matrixLabel = process.env.TYPED_SQL_POSTGRES_MATRIX_LABEL ?? `postgres-${expectedVersion}`;
  const matrixChannel = process.env.TYPED_SQL_POSTGRES_CHANNEL ?? "stable";
  const baseImage = process.env.TYPED_SQL_POSTGRES_IMAGE ?? `docker.io/library/postgres:${expectedVersion}-bookworm`;
  const containerName = `typed-sql-e2e-postgres-${process.pid}`;
  const imageName = `localhost/typed-sql-e2e-${matrixLabel}`;
  const connectionString = `postgresql://typed_sql:typed_sql_e2e@127.0.0.1:${port}/typed_sql_e2e`;
  let containerStarted = false;

  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new TypeError("TYPED_SQL_E2E_PORT must be an unprivileged TCP port");

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

  log(`Building ${imageName} from ${baseImage}`);
  await mustRun(engine, [
    "build",
    "--build-arg",
    `POSTGRES_IMAGE=${baseImage}`,
    "--tag",
    imageName,
    "--file",
    "Containerfile",
    ".",
  ]);

  try {
    await mustRun(engine, [
      "run",
      "--detach",
      "--name",
      containerName,
      "--publish",
      `127.0.0.1:${port}:5432`,
      "--env",
      "POSTGRES_DB=typed_sql_e2e",
      "--env",
      "POSTGRES_USER=typed_sql",
      "--env",
      "POSTGRES_PASSWORD=typed_sql_e2e",
      imageName,
    ]);
    containerStarted = true;
    try {
      const initializationComplete = "PostgreSQL init process complete; ready for start up.";
      const acceptingConnections = "database system is ready to accept connections";
      await waitForExpectedResult(
        async () => {
          const logs = await run(engine, ["logs", containerName]);
          const output = `${logs.stdout}${logs.stderr}`;
          const initializationIndex = output.lastIndexOf(initializationComplete);
          return (
            initializationIndex >= 0 && output.indexOf(acceptingConnections, initializationIndex) > initializationIndex
          );
        },
        true,
        { interval: 250, timeout: 60_000, strict: true },
      );
      await waitForPort(port, { host: "127.0.0.1", timeout: 60_000 });
      await waitForExpectedResult(
        async () => {
          const result = await run(engine, [
            "exec",
            containerName,
            "psql",
            "--username",
            "typed_sql",
            "--dbname",
            "typed_sql_e2e",
            "--tuples-only",
            "--no-align",
            "--command",
            "SELECT count(*) FROM public.users",
          ]);
          return result.code === 0 ? result.stdout.trim() : "";
        },
        "2",
        { interval: 250, timeout: 60_000, strict: true },
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
    connectionString,
    expectedVersion,
    matrixLabel,
    matrixChannel,
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
