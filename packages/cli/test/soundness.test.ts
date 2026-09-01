import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileSource } from "@typed-sql/compiler";
import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import {
  type SourceSoundnessCase,
  sourceForDialect,
  sourceSoundnessCorpus,
} from "../../../test/soundness/source-corpus.js";
import { mysql } from "../../mysql/src/index.js";
import { postgres } from "../../postgres/src/index.js";

const execFile = promisify(execFileCallback);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(packageDirectory, "../..");
const postgresDirectory = resolve(workspace, "e2e/postgres");
const mysqlDirectory = resolve(workspace, "e2e/mysql");
const postgresSchema = postgres().validateSnapshot(
  JSON.parse(await readFile(resolve(postgresDirectory, "generated/db/schema.json"), "utf8")) as unknown,
);
const mysqlSchema = mysql().validateSnapshot(
  JSON.parse(await readFile(resolve(mysqlDirectory, "generated/db/schema.json"), "utf8")) as unknown,
);
const cli = join(packageDirectory, "src", "cli.ts");
const tsx = fileURLToPath(import.meta.resolve("tsx"));

interface CliFixture<Snapshot extends SchemaSnapshot, Policy> {
  readonly name: "postgres" | "mysql";
  readonly directory: string;
  readonly schema: Snapshot;
  readonly dialect: DialectPlugin<Snapshot, Policy>;
}

async function execute(file: string, fixture: Pick<CliFixture<SchemaSnapshot, unknown>, "directory">) {
  return execFile(
    process.execPath,
    [
      "--import",
      tsx,
      cli,
      "check",
      "--config",
      resolve(fixture.directory, "typed-sql.config.ts"),
      "--file",
      file,
      "--project",
      resolve(fixture.directory, "tsconfig.json"),
    ],
    { cwd: workspace },
  );
}

async function verifyCase<Snapshot extends SchemaSnapshot, Policy>(
  testCase: SourceSoundnessCase,
  fixture: CliFixture<Snapshot, Policy>,
  temporary: string,
  index: number,
): Promise<void> {
  const source = sourceForDialect(testCase, fixture.name);
  const file = resolve(temporary, `${index}-${testCase.id}.ts`);
  await writeFile(file, source);
  const compilation = compileSource({ source, schema: fixture.schema, dialect: fixture.dialect });
  if (testCase.expectation.kind !== "diagnostic") {
    const result = await execute(file, fixture);
    strict.strictEqual(result.stderr, "");
    return;
  }

  await strict.rejects(execute(file, fixture), (error: unknown) => {
    if (!(error instanceof Error && "stderr" in error)) return false;
    const stderr = String(error.stderr);
    for (const diagnostic of compilation.diagnostics) {
      strict.ok(
        stderr.includes(
          `${file}:${diagnostic.range.line}:${diagnostic.range.column} - ${diagnostic.severity} ${diagnostic.code}:`,
        ),
        stderr,
      );
    }
    return true;
  });
}

await describe("CLI soundness corpus parity", async () => {
  const postgresTemporary = await mkdtemp(resolve(postgresDirectory, ".soundness-cli-"));
  const mysqlTemporary = await mkdtemp(resolve(mysqlDirectory, ".soundness-cli-"));
  try {
    for (const [index, testCase] of sourceSoundnessCorpus.entries()) {
      await it(`postgres: ${testCase.id}`, () =>
        verifyCase(
          testCase,
          { name: "postgres", directory: postgresDirectory, schema: postgresSchema, dialect: postgres() },
          postgresTemporary,
          index,
        ));
      await it(`mysql: ${testCase.id}`, () =>
        verifyCase(
          testCase,
          { name: "mysql", directory: mysqlDirectory, schema: mysqlSchema, dialect: mysql() },
          mysqlTemporary,
          index,
        ));
    }
  } finally {
    await Promise.all([
      rm(postgresTemporary, { recursive: true, force: true }),
      rm(mysqlTemporary, { recursive: true, force: true }),
    ]);
  }
});
