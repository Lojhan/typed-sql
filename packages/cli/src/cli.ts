#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFile } from "@typed-sql/compiler";
import { fromConfig, loadConfig } from "@typed-sql/config";
import type { SchemaSnapshot } from "@typed-sql/core";
import { checkSchemaDrift, generateSchemaPackage, loadGeneratedSchemaSnapshot } from "@typed-sql/schema";

interface ParsedArguments {
  readonly command?: string;
  readonly options: Readonly<Record<string, string>>;
}

const commands = new Set(["check", "generate", "drift"]);

async function packageVersion(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url));
  const root = parse(directory).root;
  while (directory !== root) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        readonly name?: string;
        readonly version?: string;
      };
      if (manifest.name === "@typed-sql/cli" && manifest.version !== undefined) return manifest.version;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    directory = dirname(directory);
  }
  throw new Error("Could not determine the @typed-sql/cli version");
}

function help(version: string): string {
  return `typed-sql ${version}

Usage:
  typed-sql <command> [options]

Commands:
  check      Infer SQL result types and verify them with TypeScript 7
  generate   Introspect or load a schema snapshot and generate the typed contract
  drift      Compare the generated contract with the live database catalog

Global options:
  -h, --help       Show this help
  -v, --version    Show the installed CLI version

Examples:
  typed-sql check --config typed-sql.config.ts --file src/query.ts --project tsconfig.json
  typed-sql generate --config typed-sql.config.ts --out generated/db
  typed-sql drift --config typed-sql.config.ts
`;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const command = args[0];
  const options: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${argument}`);
    const equals = argument.indexOf("=");
    if (equals !== -1) options[argument.slice(2, equals)] = argument.slice(equals + 1);
    else {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      options[argument.slice(2)] = value;
      index += 1;
    }
  }
  return { ...(command === undefined ? {} : { command }), options };
}

function required(options: Readonly<Record<string, string>>, name: string): string {
  const value = options[name];
  if (value === undefined) throw new Error(`Missing required --${name}`);
  return value;
}

async function readSnapshot(path: string, validate: (value: unknown) => SchemaSnapshot): Promise<SchemaSnapshot> {
  return validate(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const version = await packageVersion();
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(help(version));
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const parsed = parseArguments(args);
  if (parsed.command === undefined || !commands.has(parsed.command)) {
    throw new Error(`Unknown command ${parsed.command ?? "<none>"}. Run typed-sql --help for usage.`);
  }
  const loaded = await loadConfig({ ...(parsed.options.config === undefined ? {} : { file: parsed.options.config }) });
  const config = loaded.config;
  const dialect = config.dialect;
  const policy = config.typePolicy ?? dialect.defaultTypePolicy;
  const schemaFile = fromConfig(loaded.directory, parsed.options.schema ?? config.schema.file);

  if (parsed.command === "check") {
    const file = resolve(required(parsed.options, "file"));
    const result = await checkFile({
      file,
      schema: schemaFile,
      dialect,
      typePolicy: policy,
      ...(config.compiler?.maxStructuralVariants === undefined
        ? {}
        : { maxStructuralVariants: config.compiler.maxStructuralVariants }),
      ...(parsed.options.project === undefined ? {} : { project: resolve(parsed.options.project) }),
    });
    for (const diagnostic of result.sqlDiagnostics) {
      const suggestion = diagnostic.suggestion === undefined ? "" : ` ${diagnostic.suggestion}`;
      process.stderr.write(
        `${file}:${diagnostic.range.line}:${diagnostic.range.column} - ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${suggestion}\n`,
      );
    }
    if (result.typeScript?.output) process.stderr.write(result.typeScript.output);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (parsed.command === "generate") {
    const current =
      parsed.options.snapshot !== undefined
        ? await readSnapshot(resolve(parsed.options.snapshot), (value) => dialect.validateSnapshot(value))
        : config.schema.provider === undefined
          ? await readSnapshot(schemaFile, (value) => dialect.validateSnapshot(value))
          : await config.schema.provider.introspect();
    const metadata = await generateSchemaPackage(current as never, {
      outDir: fromConfig(loaded.directory, parsed.options.out ?? config.outDir),
      typePolicy: policy,
      dialectVersion: dialect.grammarVersion,
    });
    process.stdout.write(`Generated schema ${metadata.schemaHash}\n`);
    return;
  }

  if (parsed.command === "drift") {
    if (config.schema.provider === undefined)
      throw new Error("typed-sql drift requires schema.provider in typed-sql.config.ts");
    const generated = await loadGeneratedSchemaSnapshot(schemaFile);
    const current = await config.schema.provider.introspect();
    const drift = checkSchemaDrift(generated, current as never, policy);
    if (drift.drifted) {
      process.stderr.write(
        `error TSQ301: Schema drift detected (schemaChanged=${drift.schemaChanged}, typePolicyChanged=${drift.typePolicyChanged})\n`,
      );
      process.exitCode = 1;
    } else process.stdout.write("No schema drift detected\n");
    return;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
