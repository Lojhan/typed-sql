import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DUCKDB_SUPPORT_POLICY } from "../src/support-policy.ts";

// Discover exact SDK declarations from the owner policy and package manifest. Every engine
// runs in a fresh child: loading two DuckDB native versions together can interpose symbols.
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const skipCurrent = process.argv.slice(2).includes("--skip-current");
if (process.argv.slice(2).some((argument) => argument !== "--skip-current"))
  throw Error("Unknown native-profile option");
const current = process.env.TYPED_SQL_DUCKDB_SDK_PACKAGE ?? "@duckdb/node-api";
const targets = DUCKDB_SUPPORT_POLICY.qualifiedEngines.map((engine) => {
  const version = DUCKDB_SUPPORT_POLICY.nodeApi[engine];
  const matches = Object.entries(manifest.devDependencies).filter(([name, declaration]) =>
    name === "@duckdb/node-api" ? declaration === version : declaration === `npm:@duckdb/node-api@${version}`,
  );
  if (matches.length !== 1) throw Error(`DuckDB ${engine} needs exactly one pinned SDK declaration for ${version}`);
  return { engine, name: matches[0][0] };
});
if (!targets.some((target) => target.name === current)) throw Error("Current SDK is not a qualified declared target");
for (const target of targets) {
  if (skipCurrent && target.name === current) continue;
  process.stdout.write(`Qualifying DuckDB ${target.engine} through ${target.name}\n`);
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {poku} from 'poku'; await poku(['test/native-contracts.test.ts'],{reporter:'compact',enforce:true});",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        TYPED_SQL_DUCKDB_SDK_PACKAGE: target.name,
        TYPED_SQL_DUCKDB_EXPECTED_ENGINE: `v${target.engine}`,
      },
      stdio: "inherit",
    },
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(Error(`DuckDB ${target.engine} qualification failed (${signal ?? code})`)),
    );
  });
}
