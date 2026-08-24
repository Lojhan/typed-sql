#!/usr/bin/env node
import { resolve } from "node:path";
import { checkFile } from "@typed-sql/compiler";
import {
  checkSchemaDrift,
  defaultPostgresTypePolicy,
  generateSchemaPackage,
  introspectPostgres,
  loadGeneratedSchemaSnapshot,
  loadSchemaSnapshot,
  loadTypePolicy,
  type SchemaSnapshot,
  type TypePolicy,
} from "@typed-sql/schema";

interface ParsedArguments {
  readonly command?: string;
  readonly options: Readonly<Record<string, string>>;
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

async function policyFrom(options: Readonly<Record<string, string>>): Promise<TypePolicy> {
  return options.policy === undefined ? defaultPostgresTypePolicy : loadTypePolicy(resolve(options.policy));
}

async function schemaFrom(options: Readonly<Record<string, string>>, snapshotOption = "snapshot"): Promise<SchemaSnapshot> {
  const snapshot = options[snapshotOption];
  if (snapshot !== undefined) return loadSchemaSnapshot(resolve(snapshot));
  const provider = required(options, "provider");
  if (provider !== "postgres") throw new Error(`Unsupported schema provider ${provider}`);
  const includeSchemas = options.schemas?.split(",").map((schema) => schema.trim()).filter(Boolean);
  return introspectPostgres(
    { url: required(options, "url") },
    {
      typePolicy: await policyFrom(options),
      ...(includeSchemas === undefined || includeSchemas.length === 0 ? {} : { includeSchemas }),
    },
  );
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "check") {
    const file = resolve(required(parsed.options, "file"));
    const result = await checkFile({
      file,
      schema: resolve(required(parsed.options, "schema")),
      ...(parsed.options.project === undefined ? {} : { project: resolve(parsed.options.project) }),
    });
    for (const diagnostic of result.sqlDiagnostics) {
      const suggestion = diagnostic.suggestion === undefined ? "" : ` ${diagnostic.suggestion}`;
      process.stderr.write(`${file}:${diagnostic.range.line}:${diagnostic.range.column} - ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${suggestion}\n`);
    }
    if (result.typeScript?.output) process.stderr.write(result.typeScript.output);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (parsed.command === "generate") {
    const policy = await policyFrom(parsed.options);
    const snapshot = await schemaFrom(parsed.options);
    const metadata = await generateSchemaPackage(snapshot, { outDir: resolve(required(parsed.options, "out")), typePolicy: policy });
    process.stdout.write(`Generated schema ${metadata.schemaHash}\n`);
    return;
  }
  if (parsed.command === "drift") {
    const generated = await loadGeneratedSchemaSnapshot(resolve(required(parsed.options, "schema")));
    const policy = await policyFrom(parsed.options);
    const current = await schemaFrom(parsed.options, "current-snapshot");
    const drift = checkSchemaDrift(generated, current, policy);
    if (drift.drifted) {
      process.stderr.write(`error TSQ301: Schema drift detected (schemaChanged=${drift.schemaChanged}, typePolicyChanged=${drift.typePolicyChanged})\n`);
      process.exitCode = 1;
    } else process.stdout.write("No schema drift detected\n");
    return;
  }
  process.stdout.write("typed-sql check --file <query.ts> --schema <schema.json> [--project tsconfig.json]\n");
  process.stdout.write("typed-sql generate (--snapshot <schema.json> | --provider postgres --url <url>) --out <directory> [--policy policy.json]\n");
  process.stdout.write("typed-sql drift --schema <generated/schema.json> (--current-snapshot <schema.json> | --provider postgres --url <url>)\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
