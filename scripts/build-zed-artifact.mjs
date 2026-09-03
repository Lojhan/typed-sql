import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const workspace = resolve(import.meta.dirname, "..");
const manifest = resolve(workspace, "editors/zed/Cargo.toml");
const artifactDirectory = resolve(workspace, "artifacts");
const built = resolve(workspace, "editors/zed/target/wasm32-wasip2/release/typed_sql_zed.wasm");
const output = resolve(artifactDirectory, "typed-sql-zed.wasm");
const inheritedFlags = process.env.RUSTFLAGS?.trim();
const remap = `--remap-path-prefix=${homedir()}=/typed-sql-build`;

await execFile("cargo", ["build", "--release", "--target", "wasm32-wasip2", "--manifest-path", manifest], {
  cwd: workspace,
  env: { ...process.env, RUSTFLAGS: inheritedFlags === undefined ? remap : `${inheritedFlags} ${remap}` },
  maxBuffer: 16 * 1024 * 1024,
});
await mkdir(artifactDirectory, { recursive: true });
await copyFile(built, output);

console.log("built portable typed-sql Zed WASM artifact");
