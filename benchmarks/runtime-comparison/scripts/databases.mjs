import { spawnSync } from "node:child_process";

const action = process.argv[2];
if (action !== "start" && action !== "stop") throw new TypeError("Expected database action: start or stop");

function available(command, args) {
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

function composeCommand() {
  const preferred = process.env.TYPED_SQL_CONTAINER_ENGINE;
  const candidates =
    preferred === "podman"
      ? [["podman", "compose"], ["podman-compose"]]
      : preferred === "docker"
        ? [["docker", "compose"]]
        : [["docker", "compose"], ["podman", "compose"], ["podman-compose"]];
  for (const [command, subcommand] of candidates) {
    const prefix = subcommand === undefined ? [] : [subcommand];
    if (available(command, [...prefix, "version"])) return { command, prefix };
  }
  throw new Error(
    "No Compose implementation was found. Install Docker Compose or Podman Compose, or set TYPED_SQL_CONTAINER_ENGINE.",
  );
}

const { command, prefix } = composeCommand();
const args =
  action === "start" ? [...prefix, "up", "--detach", "--wait"] : [...prefix, "down", "--volumes", "--remove-orphans"];
const result = spawnSync(command, args, { stdio: "inherit" });
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
