import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { consumer } from "../build/src/consumer.mjs";
import { lockDatabase, offlineCommands, prepareProject } from "./offline.mjs";

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
    ["@duckdb/node-api", "typescript", "@types/node", "esbuild"],
    ["@typed-sql/duckdb", "@typed-sql/compiler", "@typed-sql/cli"],
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
    for (const file of ["consumer.mjs", "advanced.mjs", "lock-holder.mjs"])
      await cp(join(directory, file), join(project, file));
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
    const environment = { TYPED_SQL_DUCKDB_EXPECTED_ENGINE: engine };
    await prepareProject(project, directory);
    const lock = await lockDatabase(project, environment);
    try {
      const probe = await fixture.node(
        project,
        `import assert from 'node:assert/strict';import * as sdk from '@duckdb/node-api';assert.equal(sdk.version(),${JSON.stringify(engine)});await assert.rejects(sdk.DuckDBInstance.create('persistent.duckdb'),/lock/iu);console.log('independent native open is blocked by the child-held write lock');`,
        "lock-proof.mjs",
      );
      assert.match(probe.output, /blocked/u);
      const offline = await offlineCommands(fixture, project, environment);
      await writeFile(join(artifacts, `${engine}-offline.log`), `${probe.output}\n${offline}`);
      // A second packed installation has no SDK, proving public config/declarations and
      // offline transforms do not require the optional application-owned native package.
      const noDriver = await consumer(
        ["typescript", "@types/node", "esbuild"],
        ["@typed-sql/duckdb", "@typed-sql/cli"],
      );
      try {
        await assert.rejects(
          stat(join(noDriver.directory, "node_modules/@duckdb/node-api")),
          (error) => error.code === "ENOENT",
        );
        const noDriverProject = join(noDriver.directory, "application");
        await mkdir(noDriverProject);
        await prepareProject(noDriverProject, directory, await readFile(join(project, "schema.json"), "utf8"));
        const transcript = await offlineCommands(noDriver, noDriverProject, {
          ...environment,
          TYPED_SQL_DUCKDB_PATH: join(project, "persistent.duckdb"),
        });
        await writeFile(join(artifacts, `${engine}-offline-no-sdk.log`), transcript);
      } finally {
        await noDriver.close();
      }
    } finally {
      await lock.close();
    }
    const executed = await fixture.command(project, process.execPath, ["execute.mjs"], { env: environment });
    await writeFile(join(artifacts, `${engine}-bundled.log`), executed.output);
    await rm(join(artifacts, `${engine}-failure.log`), { force: true });
    console.log(
      `${sdk}: packed runtime, services/appender, strict CLI config, offline CLI/build under native lock with/without SDK, and bundled execution passed`,
    );
  } catch (error) {
    await writeFile(join(artifacts, `${engine}-failure.log`), String(error));
    throw error;
  } finally {
    await fixture.close();
  }
}
