import { execFile as callback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.js";
import type { PlaygroundDialect } from "../../website/.vitepress/theme/playground/playground.js";
import { analyzeSqlFiles } from "../../website/.vitepress/theme/playground/workspace-sql.js";
import { writeNetworkDenialPreload } from "./network-denial.js";

/** New queries in installed cores: no durable contracts, no prior cache and trapped network APIs. */
export async function assertColdCoreConsumer(consumer: string, env: NodeJS.ProcessEnv): Promise<void> {
  // Packed application processes must not inherit the test runner's tsx loader/IPC hooks.
  const applicationEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => key !== "NODE_OPTIONS" && key !== "NODE_PATH" && !key.startsWith("TSX_")),
  );
  const ledger = JSON.parse(await readFile(new URL("../../grammar/features/ledger.json", import.meta.url), "utf8"));
  const grammars = Object.keys(ledger.dialects) as PlaygroundDialect[];
  const fixtures = grammars.map((grammar) => {
    const parsed = analyzeSqlFiles(grammar, commerceFiles(grammar));
    if (!parsed.snapshot || parsed.problems.some((problem) => problem.severity === "error"))
      throw Error(`Invalid maintained fixture for ${grammar}`);
    return { grammar, schema: parsed.snapshot };
  });
  const directory = join(consumer, "cold-core");
  await mkdir(directory);
  const preload = join(directory, "deny-network.mjs");
  await writeNetworkDenialPreload(preload, "Cold core consumer attempted network access", true);
  const script = join(directory, "check.mjs");
  await writeFile(
    script,
    `
import assert from "node:assert/strict";
import {existsSync,readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {join} from "node:path";
import {connect} from "node:net";
import {lookup} from "node:dns";
import {compileSource} from "@typed-sql/compiler";
const key=Symbol.for("typed-sql.test.networkAttempts");
assert.equal(globalThis[key],0,"Importing the compiler attempted network access");
for(const probe of [()=>connect(9,"127.0.0.1"),()=>lookup("example.invalid"),()=>fetch("https://example.invalid")]) assert.throws(probe,/Cold core consumer attempted network access/u);
assert.equal(globalThis[key],3);globalThis[key]=0;
const ipcKey=Symbol.for("typed-sql.test.deniedIpcAttempts");
const beforeIpc=globalThis[ipcKey];
assert.throws(()=>connect({path:join(${JSON.stringify(directory)},"absent-compiler-ipc.sock")}),/Cold core consumer attempted network access/u);
assert.equal(globalThis[ipcKey],beforeIpc+1);assert.equal(globalThis[key],0);
const require=createRequire(import.meta.url);
for(const driver of ["pg","mysql2","koffi","mssql","tedious","msnodesqlv8","@duckdb/node-api","@libsql/client"]) assert.throws(()=>require.resolve(driver),{code:"MODULE_NOT_FOUND"});
const fixtures=${JSON.stringify(fixtures)};
for(const {grammar,schema} of fixtures){
  const metadata=JSON.parse(readFileSync(join(${JSON.stringify(consumer)},"node_modules/@typed-sql",grammar,"package.json"),"utf8"));
  const evidence=schema.server?.versionKey??schema.version??"";
  const entries=Object.keys(metadata.exports).filter((entry)=>/^\\.\\/analysis\\/core(?:\\/[^/]+)?$/u.test(entry)).filter((entry)=>{
    const version=entry.slice("./analysis/core".length).replace(/^\\//u,"");
    return version===""||evidence===version||evidence.startsWith(version+".");
  });
  assert.equal(entries.length,1,"Expected one matching installed core for "+grammar+" "+evidence);
  const entry="@typed-sql/"+grammar+entries[0].slice(1);
  const module=await import(entry);
  const dialect=module[grammar]();
  const snapshot=dialect.validateSnapshot(schema);
  const application=join(${JSON.stringify(directory)},grammar);mkdirSync(application);
  assert.equal(existsSync(join(application,".typed-sql")),false);
  assert.equal(existsSync(join(${JSON.stringify(consumer)},".typed-sql")),false);
  const source='import {sql} from "@typed-sql/'+grammar+'"; export function query(){return sql\`SELECT COALESCE(CAST(\${null} AS DECIMAL(10,2)), CAST(\${null} AS DECIMAL(10,2))) AS amount\`;}';
  const result=compileSource({source,fileName:join(application,"application.ts"),schema:snapshot,dialect,runtimeMetadata:true});
  assert.deepEqual(result.diagnostics,[],grammar+" failed cold offline compilation");
  assert.equal(result.queries.length,1);
  const query=result.queries[0];
  assert.match(query.rowType,/amount/u);assert.doesNotMatch(query.rowType,/\\b(?:unknown|any)\\b/u);
  assert.equal(query.query.parameterCount,2);
  assert.equal(query.valuePlan.dialect,grammar);
  assert.equal(query.valuePlan.columns[0].name,"amount");assert.equal(query.valuePlan.columns[0].nullable,true);
  assert.deepEqual(query.valuePlan.parameters.map((parameter)=>parameter.index),[1,2]);
  assert.equal(globalThis[key],0,grammar+" attempted network access");
  assert.equal(existsSync(join(application,".typed-sql")),false);
  writeFileSync(join(application,"application.ts"),source);
  writeFileSync(join(application,"schema.json"),JSON.stringify(snapshot));
  writeFileSync(join(application,"tsconfig.json"),JSON.stringify({compilerOptions:{strict:true,noEmit:true,target:"ESNext",module:"NodeNext",moduleResolution:"NodeNext",types:[]},files:["application.ts"]}));
  writeFileSync(join(application,"typed-sql.config.mjs"),'import {defineConfig} from "@typed-sql/core";import {'+grammar+'} from '+JSON.stringify(entry)+';export default defineConfig({dialect:'+grammar+'(),schema:{file:"schema.json"},outDir:"generated",projects:["tsconfig.json"]});');
  process.stdout.write(JSON.stringify({grammar,application,entry})+"\\n");
}
assert.equal(globalThis[key],0);
`,
  );
  const run = promisify(callback);
  const result = await run(process.execPath, ["--import", preload, script], { cwd: directory, env: applicationEnv });
  const rows = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { grammar: string; application: string });
  if (rows.length !== fixtures.length) throw Error("Cold-core fixture count changed");
  const cli = join(consumer, "node_modules/@typed-sql/cli/dist/packages/cli/src/cli.js");
  for (const row of rows) {
    for (const base of [consumer, directory, row.application])
      if (existsSync(join(base, ".typed-sql"))) throw Error(`Unexpected cold-core cache for ${row.grammar}`);
    await run(process.execPath, ["--import", preload, cli, "check", "--offline", "--show-types"], {
      cwd: row.application,
      env: applicationEnv,
    });
    for (const base of [consumer, directory, row.application])
      if (existsSync(join(base, ".typed-sql")))
        throw Error(`Cold-core check created analysis cache for ${row.grammar}`);
  }
}
