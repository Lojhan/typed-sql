import { execFile as callback } from "node:child_process";
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writeNetworkDenialPreload } from "./network-denial.js";
import { createPackedNativeEditorConsumer } from "./packed-editor-consumer.js";

const execFile = promisify(callback);

async function omitPostgresAnalyzer(consumer: string): Promise<void> {
  const grammar = join(consumer, "node_modules", "@typed-sql", "postgres", "dist", "packages", "postgres", "src");
  for (const path of [
    "catalog",
    "vocabulary",
    "analysis",
    "analysis.js",
    "analysis-factory.js",
    "selected-analysis.js",
    "core-analysis.js",
    "project-catalog.js",
    "project-catalog-policy.js",
    "project-catalog-source.js",
    "project-catalog-selection.js",
    "routine-catalog.js",
    "resolver-engine.js",
    "semantics-engine.js",
    "resolver.js",
    "semantics.js",
    "provider.js",
    "query.js",
    "runtime.js",
    "pg.js",
    "pg-contracts.js",
    "reconciliation.js",
    "parser/parser.js",
  ])
    if (path.endsWith(".js")) {
      for (const suffix of [".js", ".d.ts", ".js.map", ".d.ts.map"])
        await rm(join(grammar, `${path.slice(0, -3)}${suffix}`), { force: true });
    } else await rm(join(grammar, path), { recursive: true, force: true });
}

/** Runtime decoding keeps scalar codec facts, but must not require semantic inventories. */
async function assertRuntimeWithoutSemanticCatalogs(consumer: string, env: NodeJS.ProcessEnv): Promise<void> {
  const workspace = fileURLToPath(new URL("../../", import.meta.url));
  const ledger = JSON.parse(await readFile(join(workspace, "grammar/features/ledger.json"), "utf8"));
  const grammars = Object.keys(ledger.dialects).sort();
  if (!grammars.length) throw new Error("No declared grammars in the runtime boundary audit");
  const runtimeEntries: string[] = [];
  const essential = new Set(["coercions.js", "generated/types.js", "generated/aliases.js"]);
  const strip = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name,
        path = join(directory, entry.name);
      if (entry.isDirectory()) await strip(path, `${relative}/`);
      else if (entry.isFile() && !essential.has(relative.replace(/(?:\.d\.ts|\.js)(?:\.map)?$/u, ".js")))
        await rm(path);
    }
  };
  for (const name of grammars) {
    const grammar = join(consumer, "node_modules", "@typed-sql", name, "dist", "packages", name, "src");
    const manifest = JSON.parse(
      await readFile(join(consumer, "node_modules", "@typed-sql", name, "package.json"), "utf8"),
    );
    const exports = Object.keys(manifest.exports);
    const development = manifest.typedSql.developmentEntrypoints;
    if (
      !Array.isArray(development) ||
      development.some((entry: string) => !exports.includes(entry)) ||
      development.includes(".") ||
      development.includes("./runtime")
    )
      throw new Error(`Invalid development entrypoint policy for ${name}`);
    for (const entry of exports)
      if (!development.includes(entry)) runtimeEntries.push(`@typed-sql/${name}${entry === "." ? "" : entry.slice(1)}`);
    for (const entry of development) {
      const target = manifest.exports[entry];
      if (typeof target !== "string" || !target.endsWith(".js"))
        throw new Error(`Invalid development export for ${name}`);
      const stem = join(consumer, "node_modules", "@typed-sql", name, target.slice(0, -3));
      for (const suffix of [".js", ".d.ts", ".js.map", ".d.ts.map"]) await rm(`${stem}${suffix}`, { force: true });
    }
    await strip(join(grammar, "catalog"));
    if (name === "postgres" || name === "sqlite")
      for (const directory of ["analysis", "vocabulary"])
        await rm(join(grammar, directory), { recursive: true, force: true });
    for (const module of [
      "analysis",
      ...(name === "duckdb"
        ? ["analysis-factory", "selected-analysis", "resolver-engine", "node-api-contracts", "reconciliation"]
        : []),
      ...(name === "postgres"
        ? [
            "analysis-factory",
            "selected-analysis",
            "core-analysis",
            "project-catalog",
            "project-catalog-policy",
            "project-catalog-source",
            "project-catalog-selection",
            "routine-catalog",
            "resolver-engine",
            "semantics-engine",
            "type-resolution-engine",
            "extensions-engine",
          ]
        : []),
      "browser",
      "resolver",
      "semantics",
      "provider",
      ...(name === "postgres" ? ["extensions"] : []),
    ])
      for (const suffix of [".js", ".d.ts", ".js.map", ".d.ts.map"])
        await rm(join(grammar, `${module}${suffix}`), { force: true });
  }
  await writeFile(join(consumer, "runtime-grammars.json"), JSON.stringify(grammars));
  await writeFile(join(consumer, "runtime-entrypoints.json"), JSON.stringify(runtimeEntries));
  const file = join(consumer, "runtime-without-catalogs.mjs");
  await writeFile(
    file,
    `
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
for (const entry of JSON.parse(await readFile("./runtime-entrypoints.json","utf8"))) {
  const runtime=await import(entry);
  assert.ok(Object.keys(runtime).length,entry+" has no exports");
}

import {sql,defineQueryValuePlan,withQueryValuePlan} from "@typed-sql/postgres/tag";
import {createPostgresDatabase} from "@typed-sql/postgres/runtime";
import {calculateTypePolicyHash} from "@typed-sql/schema";
import {typePolicy} from "@typed-sql/postgres/profile";
let invalid=false;
const calls=[];
const pool={query:async config=>{calls.push(config);return {rows:[{value:invalid?"invalid":42n}]};},connect:async()=>{throw Error("Unexpected lease");}};
const database=createPostgresDatabase({pool});
const plan=defineQueryValuePlan({dialect:"postgres",typePolicyHash:calculateTypePolicyHash(typePolicy),
  columns:[{name:"value",type:"bigint",databaseType:"bigint",nullable:false}],
  parameters:[{index:1,type:"bigint",databaseType:"bigint",nullable:false}]});
const query=withQueryValuePlan(sql\`SELECT \${41n}::bigint AS value\`,plan);
assert.deepEqual(await database.all(query),[{value:42n}]);
assert.equal(calls[0].text,"SELECT $1::bigint AS value");
assert.equal(calls[0].values.length,1);
invalid=true;
await assert.rejects(database.all(query));
`,
  );
  await execFile(process.execPath, [file], { cwd: consumer, env });
  // Profiles and roots must also load without providers, in a fresh module graph.
  for (const name of grammars) {
    const grammar = join(consumer, "node_modules", "@typed-sql", name, "dist", "packages", name, "src");
    for (const suffix of [".js", ".d.ts", ".js.map", ".d.ts.map"]) {
      await rm(join(grammar, `provider${suffix}`), { force: true });
      // DuckDB needs its contextual syntax parser to distinguish frontend bind markers.
      if (name !== "duckdb") await rm(join(grammar, "parser", `parser${suffix}`), { force: true });
    }
  }
  const profileFile = join(consumer, "profiles-without-analyzers.mjs");
  await writeFile(
    profileFile,
    `
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
for (const grammar of JSON.parse(await readFile("./runtime-grammars.json","utf8"))) {
  const profiles=await import("@typed-sql/"+grammar+"/profile");
  const root=await import("@typed-sql/"+grammar);
  assert.equal(root[grammar+"Profile"],undefined);
  assert.equal(typeof root.sql,"function");
  assert.equal(root[grammar],undefined);
  assert.deepEqual(root.typePolicy,profiles.typePolicy);
  const profile=profiles[grammar+"Profile"]();
  assert.equal(profile.id,grammar);
  assert.equal("analyze" in profile,false);
  assert.equal("loadAnalyzer" in profile,false);
  const placeholder=profile.placeholder(1);
  const text="SELECT "+placeholder+" AS value";
  const occurrences=profile.parameterOccurrences(text,{formatVersion:1,dialect:grammar,tables:{}});
  assert.equal(occurrences.length,1,grammar+" parameter occurrence");
  assert.equal(occurrences[0].index,1,grammar+" parameter index");
  assert.equal(text.slice(occurrences[0].range.start,occurrences[0].range.end),placeholder);
  assert.throws(()=>profile.validateSnapshot({formatVersion:1,dialect:"wrong",tables:{}}));
}
`,
  );
  await execFile(process.execPath, [profileFile], { cwd: consumer, env });
  const typedRoots = join(consumer, "roots-without-analyzers.ts");
  await writeFile(
    typedRoots,
    grammars
      .map(
        (name, index) =>
          `import * as grammar${index} from ${JSON.stringify(`@typed-sql/${name}`)};\nvoid grammar${index}.sql\`SELECT 1\`;\n`,
      )
      .join("\n"),
  );
  await execFile(
    "pnpm",
    [
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
      "--lib",
      "ES2024,DOM,ESNext.Disposable",
      typedRoots,
    ],
    { cwd: consumer, env, timeout: 60_000 },
  );
  // Ordinary root imports must not require profile construction or SQL statement parsing.
  const runtimeOnly = join(consumer, "runtime-only");
  for (const name of grammars) {
    const target = join(runtimeOnly, "node_modules", "@typed-sql", name);
    await cp(join(consumer, "node_modules", "@typed-sql", name), target, { recursive: true, dereference: true });
    const source = join(target, "dist", "packages", name, "src");
    await rm(join(source, "profile.js"), { force: true });
    await rm(join(source, "parser"), { recursive: true, force: true });
  }
  const runtimeFile = join(runtimeOnly, "roots.mjs");
  await writeFile(join(runtimeOnly, "grammars.json"), JSON.stringify(grammars));
  await writeFile(
    runtimeFile,
    `
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
for (const name of JSON.parse(await readFile("./grammars.json","utf8"))) {
  const root=await import("@typed-sql/"+name);
  assert.equal(typeof root.sql,"function");
  assert.equal(root[name+"Profile"],undefined);
  assert.ok(root.sql\`SELECT 1\`);
  assert.ok(root.typePolicy);
}
`,
  );
  await execFile(process.execPath, [runtimeFile], { cwd: runtimeOnly, env });
}

/** Mutates only this disposable packed installation, after its other consumer checks finish. */
export async function assertFrozenContractConsumer(consumer: string, env: NodeJS.ProcessEnv): Promise<void> {
  await assertRuntimeWithoutSemanticCatalogs(consumer, env);
  await omitPostgresAnalyzer(consumer);
  const file = join(consumer, "frozen-contract.mjs");
  await writeFile(
    file,
    `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createContractDialect, createQueryContract, exportQueryContracts, loadQueryContracts, queryContractDigest, createAnalysisContextScope, createProjectCatalog, createProjectCatalogClosure, loadFrozenContractView } from "@typed-sql/analysis";
import { collectSourceQueryCandidates, compileSource } from "@typed-sql/compiler";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { postgresProfile } from "@typed-sql/postgres/profile";
import { sql, defineQueryValuePlan, withQueryValuePlan } from "@typed-sql/postgres/tag";
import { decodeQueryResultRows } from "@typed-sql/core";
const require = createRequire(import.meta.url);
for (const name of ["pg", "mysql2", "mssql", "tedious"])
  assert.throws(() => require.resolve(name), { code: "MODULE_NOT_FOUND" });
assert.equal(typeof (await import("@typed-sql/postgres")).sql, "function");
await assert.rejects(import("@typed-sql/postgres/analysis"), { code: "ERR_MODULE_NOT_FOUND" });
const schema = { formatVersion: 1, dialect: "postgres", tables: {} };
const profile = postgresProfile();
const text = "SELECT vendor_score($1::bigint) AS score";
const context = {
  grammar: { id: "postgres", version: profile.grammarVersion },
  profileHash: queryContractDigest("packed-profile"), schemaHash: calculateSchemaHash(schema),
  databaseContextHash: queryContractDigest("packed-context"), typePolicyHash: calculateTypePolicyHash(profile.defaultTypePolicy),
  codecHash: queryContractDigest("packed-codec"), interpreterHash: queryContractDigest("packed-interpreter"),
};
// Synthetic native-shaped evidence tests the packed consumer. Real acquisition is a separate engine gate.
const field = { nativeType: { status: "known", value: { name: "bigint", complete: true } }, runtimeType: { status: "known", value: "bigint" }, nullable: { status: "unknown", reason: "not-described" }, descriptor: { oid: 20 } };
const valuePlan = defineQueryValuePlan({ dialect: "postgres", typePolicyHash: context.typePolicyHash,
  columns: [{ name: "score", type: "bigint", databaseType: "bigint", nullable: true }],
  parameters: [{ index: 1, type: "bigint", databaseType: "bigint", nullable: true }],
});
const nativeEvidence = { adapter: { id: "packed-test", version: "1" }, consistency: { mechanism: "guarded", scope: "synthetic-fixture" }, resultKind: "rows",
  columns: [{ ...field, name: "score" }], parameters: [{ ...field, index: 1 }],
  parameterOccurrences: profile.parameterOccurrences(text, schema).map(({ index, range }) => ({ index, start: range.start, end: range.end })),
};
const contract = createQueryContract({ sql: text, context, origin: "native-description", nativeEvidence, valuePlan });
await exportQueryContracts("./frozen-contracts", [contract]);
await rm("./.typed-sql", { recursive: true, force: true });
const dialect = createContractDialect({ profile, context, contracts: await loadQueryContracts("./frozen-contracts") });
const source = 'import {sql} from "@typed-sql/postgres"; const query=sql\`SELECT vendor_score(\${input}::bigint) AS score\`;';
const result = compileSource({ source, schema, dialect, runtimeMetadata: true });
assert.deepEqual(result.diagnostics, []);
assert.equal(result.queries.length, 1);
assert.match(result.queries[0].rowType, /score.*bigint.*null/u);
assert.match(result.queries[0].parameterType, /bigint.*null/u);
const query = withQueryValuePlan(sql\`SELECT vendor_score(\${7n}::bigint) AS score\`, result.queries[0].valuePlan);
assert.deepEqual(decodeQueryResultRows(query, [{ score: 8n }], { id: "packed-native", dialect: "postgres", integer: "lossless", jsonWire: "text", typePolicyHash: context.typePolicyHash }), [{ score: 8n }]);
// A sparse contributed interpreter works after all built-in analyzer/catalog modules are removed.
const functions={catalog_fixture:{name:"catalog_fixture",argumentTypes:[],returnType:"number",databaseReturnType:"integer",nullable:true}};
const owner={id:"packed/catalog-owner",version:"1",grammar:context.grammar,apply(schema){return {...schema,functions};}};
const catalogClosure=createProjectCatalogClosure({schema,context,typePolicy:profile.defaultTypePolicy,
  catalogs:[createProjectCatalog({context,owner:{id:owner.id,version:owner.version},entries:[{kind:"fixture",identity:"fixture",permission:"fixed-result",evidenceDigest:queryContractDigest(functions),definition:functions}]})],contributions:[owner]});
const configured={mode:"frozen",context,identity:{profileHash:context.profileHash,codecHash:context.codecHash,interpreterHash:context.interpreterHash},
  qualification:{mode:"hybrid",owner:{id:"packed/offline",version:"1"},requiredNativeFacets:[]},contractsDir:"contracts",
  cache:{connectionContext:queryContractDigest("packed-target"),adapter:{id:"packed/adapter",version:"1"}}};
const project=join(process.cwd(),"frozen-catalog-project");
await mkdir(project);
await exportQueryContracts(join(project,"contracts"),[createQueryContract({sql:text,context:catalogClosure.context,origin:"offline-rule",valuePlan})],{
  selection:{scope:createAnalysisContextScope({profile,schema,configuration:configured}),context:catalogClosure.context,projectCatalogs:catalogClosure}});
await writeFile(join(project,"catalog-owner.mjs"),"export const contributions=[{id:'packed/catalog-owner',version:'1',grammar:"+JSON.stringify(context.grammar)+",apply(schema){return {...schema,functions:"+JSON.stringify(functions)+"};}}];");
await writeFile(join(project,"schema.json"),JSON.stringify(schema));
await writeFile(join(project,"package.json"),'{"type":"module"}');
await writeFile(join(project,"application.ts"),source.replace("const query=sql","export function query(input:bigint){return sql")+"}");
await writeFile(join(project,"tsconfig.json"),JSON.stringify({compilerOptions:{strict:true,target:"ESNext",module:"NodeNext",moduleResolution:"NodeNext",noEmit:true},files:["application.ts"]}));
await writeFile(join(project,"typed-sql.config.mjs"),"import {postgresProfile} from '@typed-sql/postgres/profile';export default {dialect:{...postgresProfile(),loadAnalyzer(){throw Error('Frozen catalog CLI initialized an analyzer');}},schema:{file:'schema.json'},outDir:'generated',projects:['tsconfig.json'],analysis:{..."+JSON.stringify(configured)+",projectCatalogs:{async loadContributions(){return (await import('./catalog-owner.mjs')).contributions;}},live:{adapter(){throw Error('Frozen catalog CLI initialized native services');}}}};");
const selected=await loadFrozenContractView({profile,schema,configuration:configured,directory:join(project,"contracts"),loadProjectCatalogContributions:async()=>[owner]});
assert.notEqual(calculateSchemaHash(selected.schema),calculateSchemaHash(schema));
assert.deepEqual(compileSource({source,schema:selected.schema,dialect:selected.dialect}).diagnostics,[]);
const checked=spawnSync(process.execPath,[join(process.cwd(),"node_modules/@typed-sql/cli/dist/packages/cli/src/cli.js"),"check","--frozen","--show-types"],{cwd:project,env:process.env,encoding:"utf8",timeout:60000});
assert.equal(checked.status,0,checked.stdout+checked.stderr);
assert.match(checked.stdout,/bigint/u);
const manifest = JSON.parse(await readFile("./frozen-contracts/manifest.json", "utf8"));
await rm("./frozen-contracts/queries/" + manifest.queries[0] + ".json");
await assert.rejects(loadQueryContracts("./frozen-contracts"), { code: "ENOENT" });
`,
  );
  await execFile(process.execPath, [file], { cwd: consumer, env });
}

/** Real native artifacts consumed in a fresh distribution-only process, without native/analyzer modules. */
export async function assertIsolatedPostgresContractConsumer(input: {
  contracts: string;
  context: unknown;
  schema: unknown;
  source: string;
  expected: string;
  qualificationPolicyHash: string;
  qualification: unknown;
}): Promise<void> {
  const workspace = fileURLToPath(new URL("../../", import.meta.url));
  const { NODE_PATH: _nodePath, ...env } = process.env;
  const packed = await createPackedNativeEditorConsumer(
    workspace,
    env,
    ["postgres"],
    ["@typed-sql/build"],
    ["esbuild"],
  );
  const { consumer } = packed;
  try {
    await omitPostgresAnalyzer(consumer);
    await cp(input.contracts, join(consumer, "contracts"), { recursive: true });
    await writeFile(
      join(consumer, "inputs.json"),
      JSON.stringify({
        context: input.context,
        schema: input.schema,
        source: input.source,
        expected: input.expected,
        qualificationPolicyHash: input.qualificationPolicyHash,
        qualification: input.qualification,
      }),
    );
    await writeNetworkDenialPreload(
      join(consumer, "deny-network.mjs"),
      "Frozen contract consumer attempted network access",
    );
    const application = `${input.source}\nimport type { QueryRow } from "@typed-sql/core";\nfunction checkResult(result: QueryRow<ReturnType<typeof query>>) { const checked: bigint | null = result.result; return checked; }\nvoid checkResult;\n`;
    await writeFile(join(consumer, "application.ts"), application);
    await writeFile(join(consumer, "schema.json"), JSON.stringify(input.schema));
    await writeFile(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ESNext",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          types: [],
        },
        files: ["application.ts"],
      }),
    );
    await writeFile(
      join(consumer, "typed-sql.config.mjs"),
      `
import {defineConfig} from "@typed-sql/core";
import {postgresProfile} from "@typed-sql/postgres/profile";
import {postgresContractIdentity} from "@typed-sql/postgres/contract-profile";
import inputs from "./inputs.json" with {type:"json"};
export default defineConfig({
  dialect:{...postgresProfile(),loadAnalyzer(){throw Error("Frozen CLI loaded its analyzer");}},
  schema:{file:"schema.json",provider:{introspect(){throw Error("Frozen CLI loaded its provider");}}},
  outDir:"generated",projects:["tsconfig.json"],
  analysis:{mode:"frozen",context:inputs.context,identity:postgresContractIdentity(),qualification:inputs.qualification,contractsDir:"contracts"},
});
`,
    );
    const cli = join(consumer, "node_modules/@typed-sql/cli/dist/packages/cli/src/cli.js");
    const cliArgs = ["--import", join(consumer, "deny-network.mjs"), cli, "check", "--frozen", "--show-types"];
    const checked = await execFile(process.execPath, cliArgs, { cwd: consumer, env, maxBuffer: 4 * 1024 * 1024 });
    if (!checked.stdout.includes("bigint")) throw Error("Frozen packed CLI lost its native result contract");
    await writeFile(
      join(consumer, "application.ts"),
      application.replace("const checked: bigint | null", "const checked: string"),
    );
    let rejected = false;
    try {
      await execFile(process.execPath, cliArgs, { cwd: consumer, env, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      if (!`${failure.stdout ?? ""}${failure.stderr ?? ""}`.includes("TS2322")) throw error;
      rejected = true;
    }
    if (!rejected) throw Error("Frozen packed CLI accepted an incompatible downstream result type");
    await writeFile(join(consumer, "application.ts"), application);
    await writeFile(
      join(consumer, "build.mjs"),
      `
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {typedSql} from "@typed-sql/build/esbuild";
import {getQueryValuePlan} from "@typed-sql/core";
const {build}=createRequire(import.meta.resolve("@typed-sql/build/esbuild"))("esbuild");
await build({entryPoints:["application.ts"],outfile:"application.mjs",bundle:true,format:"esm",platform:"node",external:["@typed-sql/*"],plugins:[typedSql()]});
const {query}=await import("./application.mjs");
const statement=query(7n), plan=getQueryValuePlan(statement);
assert.ok(plan);
assert.equal(plan.columns[0].name,"result");assert.equal(plan.columns[0].type,"bigint");
assert.equal(plan.columns[0].nullable,true);assert.equal(plan.parameters[0].type,"bigint");
`,
    );
    await execFile(process.execPath, ["--import", join(consumer, "deny-network.mjs"), join(consumer, "build.mjs")], {
      cwd: consumer,
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    await writeFile(
      join(consumer, "consume.mjs"),
      `
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { collectSourceQueryCandidates, compileSource } from "@typed-sql/compiler";
import { loadFrozenContractView, loadQueryContracts } from "@typed-sql/analysis";
import { postgresProfile } from "@typed-sql/postgres/profile";
import { postgresContractIdentity } from "@typed-sql/postgres/contract-profile";
import { connect } from "node:net";
assert.throws(() => connect(9, "127.0.0.1"), /Frozen contract consumer attempted network access/u);
const require = createRequire(import.meta.url);
assert.throws(() => require.resolve("pg"), { code: "MODULE_NOT_FOUND" });
assert.equal(typeof (await import("@typed-sql/postgres")).sql, "function");
await assert.rejects(import("@typed-sql/postgres/analysis"), { code: "ERR_MODULE_NOT_FOUND" });
const input = JSON.parse(await readFile("./inputs.json", "utf8"));
const contracts = await loadQueryContracts("./contracts");
assert.equal(contracts[0].nativeEvidence.adapter.id, "@typed-sql/postgres/pg-contracts");
assert.equal(typeof input.qualificationPolicyHash, "string");
assert.equal(contracts[0].qualification.policyHash, input.qualificationPolicyHash);
const candidates = collectSourceQueryCandidates({ source: input.source, schema: input.schema, profile: postgresProfile() });
assert.equal(candidates.complete, true);
assert.equal(candidates.candidates.length, 1);
assert.deepEqual(candidates.candidates[0].parameterOccurrences, contracts[0].nativeEvidence.parameterOccurrences);
const result = compileSource({ source: input.source, schema: input.schema,
  dialect: (await loadFrozenContractView({ profile: postgresProfile(), schema: input.schema, directory: "./contracts",
    configuration: {mode: "frozen", context: input.context, identity: postgresContractIdentity(), qualification: input.qualification} })).dialect,
  runtimeMetadata: true });
assert.deepEqual(result.diagnostics, []);
assert.equal(result.transformedSource, input.expected);
const manifest = JSON.parse(await readFile("./contracts/manifest.json", "utf8"));
await rm("./contracts/queries/" + manifest.queries[0] + ".json");
await assert.rejects(loadQueryContracts("./contracts"), { code: "ENOENT" });
`,
    );
    await execFile(process.execPath, ["--import", join(consumer, "deny-network.mjs"), join(consumer, "consume.mjs")], {
      cwd: consumer,
      env,
    });
  } finally {
    await packed.close();
  }
}
