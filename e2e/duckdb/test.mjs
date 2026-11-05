import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { consumer } from "../build/src/consumer.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const artifacts = resolve(directory, "../../artifacts/duckdb/packed");
await mkdir(artifacts, { recursive: true });
// Each SDK lives in its own installation and child process. Loading both native
// engines in one process can interpose symbols and falsify version evidence.
for (const [sdk, engine] of [
  ["1.5.6-r.2", "v1.5.6"],
  ["2.0.0-r.1", "v2.0.0"],
]) {
  const fixture = await consumer(
    ["@duckdb/node-api", "typescript", "@types/node"],
    ["@typed-sql/duckdb", "@typed-sql/compiler"],
  );
  try {
    if (sdk !== "2.0.0-r.1")
      await fixture.command(fixture.directory, "pnpm", [
        "add",
        "--ignore-workspace",
        "--ignore-scripts",
        "-D",
        `@duckdb/node-api@${sdk}`,
      ]);
    const project = join(fixture.directory, "application");
    await mkdir(project);
    await cp(join(directory, "consumer.mjs"), join(project, "consumer.mjs"));
    const result = await fixture.command(project, process.execPath, ["consumer.mjs"], {
      env: { TYPED_SQL_DUCKDB_EXPECTED_ENGINE: engine },
    });
    await writeFile(join(artifacts, `${engine}.log`), result.output);
    const types = await fixture.command(project, "pnpm", [
      "exec",
      "tsc",
      "--strict",
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2024",
      "--skipLibCheck",
      "type-proof.ts",
    ]);
    await writeFile(join(artifacts, `${engine}-types.log`), types.output);
    console.log(`${sdk}: packed execution and TypeScript proof passed`);
  } catch (error) {
    await writeFile(join(artifacts, `${engine}-failure.log`), String(error));
    throw error;
  } finally {
    await fixture.close();
  }
}
