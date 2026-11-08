import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyEditorContracts } from "./editor-contracts.mjs";

/** Public packed CLI generation with a native-only routine shape, then frozen offline reuse. */
export async function verifyQueryContracts(fixture, application, artifacts, engine) {
  const directory = join(fixture.directory, "native-contracts");
  await mkdir(directory);
  await writeFile(join(directory, "schema.json"), await readFile(join(application, "schema.json")));
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        allowArbitraryExtensions: true,
        allowImportingTsExtensions: true,
        types: ["node"],
      },
      include: ["entry.ts", "generated/**/*.d.ts"],
    }),
  );
  await writeFile(join(directory, "entry.ts"), `import query from "./shape.sql"; export {query};\n`);
  await writeFile(
    join(directory, "shape.sql"),
    `SELECT json_transform('{}', '{"x":"INTEGER"}') AS value FROM records a LEFT JOIN records b ON a.id=b.id WHERE a.id=9223372036854775807::BIGINT`,
  );
  await writeFile(
    join(directory, "typed-sql.config.mjs"),
    `
import {defineConfig} from "@typed-sql/core";
import {duckdbProfile} from "@typed-sql/duckdb/profile";
import {duckDBContractIdentity,duckDBContractAdapterVersion,duckDBContractReconciliationOwner} from "@typed-sql/duckdb/contract-profile";
const frozen=process.env.TYPED_SQL_DUCKDB_CONTRACT_FROZEN === "1";
const offline=process.env.TYPED_SQL_DUCKDB_CONTRACT_OFFLINE === "1";
export default defineConfig({
  dialect:{...duckdbProfile(),async loadAnalyzer(){
    if(frozen||offline)throw Error("Recorded checking loaded the analyzer");
    return (await import("@typed-sql/duckdb/analysis")).duckdb();
  }},
  schema:{file:"schema.json"},outDir:"generated",projects:["tsconfig.json"],
  analysis:{mode:frozen?"frozen":offline?"offline":"live",identity:duckDBContractIdentity(),contractsDir:"contracts",
    cache:{connectionContext:"0".repeat(64),adapter:{id:"@typed-sql/duckdb/node-api-contracts",version:duckDBContractAdapterVersion}},
    qualification:{mode:"hybrid",owner:duckDBContractReconciliationOwner,requiredNativeFacets:[]},
    live:{contextIntervalMs:1,async adapter({schema}){
      if(frozen||offline)throw Error("Recorded checking initialized a native adapter");
      const {createNodeDuckDBNativeContractAdapter}=await import("@typed-sql/duckdb/node-api-contracts");
      const {createDuckDBContractReconciler}=await import("@typed-sql/duckdb/reconciliation");
      const adapter=createNodeDuckDBNativeContractAdapter({schema,path:${JSON.stringify(join(application, "persistent.duckdb"))}});
      return {connectionContext:"0".repeat(64),adapter,contribution:createDuckDBContractReconciler(),inspectContext:signal=>adapter.inspectContext(signal),async close(){/* Every native handle belongs to a completed acquisition lease. */}};
    }}
  }
});
`,
  );
  const transcript = [];
  const command = async (args, frozen = false) => {
    const result = await fixture.command(directory, "pnpm", ["exec", ...args], {
      env: { TYPED_SQL_DUCKDB_CONTRACT_FROZEN: frozen ? "1" : "0" },
    });
    transcript.push(`$ ${args.join(" ")} (${frozen ? "frozen" : "live"})\n${result.output}`);
    await writeFile(join(artifacts, `${engine}-native-contracts.log`), transcript.join("\n"));
    return result.output;
  };
  await command(["typed-sql", "generate", "--queries", "--live"]);
  await command(["typed-sql-build", "types"], true);
  assert.match(await readFile(join(directory, "shape.d.sql.ts"), "utf8"), /"x": number/u);
  const initial = await command(["typed-sql", "check", "--project", "tsconfig.json", "--show-types"]);
  assert.match(initial, /"x": number/u);
  await writeFile(
    join(directory, "shape.sql"),
    `SELECT json_transform('{}', '{"x":"VARCHAR"}') AS value FROM records a LEFT JOIN records b ON a.id=b.id WHERE a.id=9223372036854775807::BIGINT`,
  );
  await command(["typed-sql", "generate", "--queries", "--live"]);
  await command(["typed-sql-build", "types"], true);
  assert.match(await readFile(join(directory, "shape.d.sql.ts"), "utf8"), /"x": string/u);
  const regenerated = await command(["typed-sql", "check", "--project", "tsconfig.json", "--show-types"]);
  assert.match(regenerated, /"x": string/u);
  assert.notEqual(initial, regenerated);
  await command(["typed-sql", "check", "--project", "tsconfig.json", "--show-types"], true);
  await command(["typed-sql-build", "types", "--check"], true);
  await command(["tsc", "--noEmit"], true);
  await writeFile(
    join(directory, "build.mjs"),
    `
import assert from "node:assert/strict";
import {build} from "esbuild";
import {typedSql} from "@typed-sql/build/esbuild";
import {getQueryValuePlan} from "@typed-sql/core";
import {createNodeDuckDBDatabase} from "@typed-sql/duckdb/node-api";
await build({entryPoints:["entry.ts"],outfile:"bundle.mjs",bundle:true,format:"esm",platform:"node",external:["@typed-sql/*"],plugins:[typedSql()]});
const {query}=await import("./bundle.mjs");
assert.deepEqual(getQueryValuePlan(query()).columns[0].type,{object:{x:{type:"string",nullable:true}}});
const db=await createNodeDuckDBDatabase({path:${JSON.stringify(join(application, "persistent.duckdb"))}});
try {assert.deepEqual(await db.all(query()),[{value:{x:null}}]);}finally{await db.close();}
console.log("Frozen bundled SQL retains the native nested decoder plan and executes correctly");
`,
  );
  const bundled = await fixture.command(directory, process.execPath, ["build.mjs"], {
    env: { TYPED_SQL_DUCKDB_CONTRACT_FROZEN: "1" },
  });
  transcript.push(bundled.output);
  await verifyEditorContracts(fixture, directory, artifacts, engine, join(application, "persistent.duckdb"));
  await writeFile(join(artifacts, `${engine}-native-contracts.log`), transcript.join("\n"));
}
