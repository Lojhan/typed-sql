// Opt-in tracing for generated, isolated host fixtures only. Production stderr
// remains redacted by the language server; never enable this in user projects.
const { spawn } = require("node:child_process");
const { appendFileSync, realpathSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");
const resolve = createRequire(
  realpathSync(join(process.env.TYPED_SQL_PACKED_ROOT, "node_modules/@typed-sql/ts-bridge/package.json")),
);
const cli = join(dirname(resolve.resolve("@typed-sql/typescript-preview/package.json")), "bin/tsc");
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: ["pipe", "pipe", "pipe"] });
let bytes = 0;
child.stderr.on("data", (data) => {
  if (bytes < 262_144) appendFileSync(process.env.TYPED_SQL_PREVIEW_TRACE, data.subarray(0, 262_144 - bytes));
  bytes += data.length;
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("error", (error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exit(code ?? 1);
});
