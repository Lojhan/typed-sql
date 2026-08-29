import { spawnSync } from "node:child_process";

const action = process.argv[2];
if (action !== "up" && action !== "down") {
  throw new TypeError("usage: node ../compose.mjs <up|down>");
}

const engine = process.env.TYPED_SQL_CONTAINER_ENGINE ?? "docker";
const arguments_ =
  action === "up"
    ? ["compose", "up", "--build", "--detach", "--wait"]
    : ["compose", "down", "--volumes", "--remove-orphans"];
const result = spawnSync(engine, arguments_, { stdio: "inherit" });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
