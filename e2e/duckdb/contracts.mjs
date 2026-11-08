import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  await writeFile(join(directory, "shape.sql"), `SELECT json_transform('{}', '{"x":"INTEGER"}') AS value`);
  await writeFile(
    join(directory, "typed-sql.config.mjs"),
    `
import {defineConfig} from "@typed-sql/core";
import {duckdbProfile} from "@typed-sql/duckdb/profile";
import {duckDBContractIdentity,duckDBContractAdapterVersion,duckDBContractReconciliationOwner} from "@typed-sql/duckdb/contract-profile";
const frozen=process.env.TYPED_SQL_DUCKDB_CONTRACT_FROZEN === "1";
export default defineConfig({
  dialect:{...duckdbProfile(),async loadAnalyzer(){
    if(frozen)throw Error("Frozen checking loaded the analyzer");
    return (await import("@typed-sql/duckdb/analysis")).duckdb();
  }},
  schema:{file:"schema.json"},outDir:"generated",projects:["tsconfig.json"],
  analysis:{mode:frozen?"frozen":"live",identity:duckDBContractIdentity(),contractsDir:"contracts",
    cache:{connectionContext:"0".repeat(64),adapter:{id:"@typed-sql/duckdb/node-api-contracts",version:duckDBContractAdapterVersion}},
    qualification:{mode:"hybrid",owner:duckDBContractReconciliationOwner,requiredNativeFacets:[]},
    live:{async adapter({schema}){
      if(frozen)throw Error("Frozen checking initialized a native adapter");
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
  const initial = await command(["typed-sql", "check", "--project", "tsconfig.json", "--show-types"]);
  assert.match(initial, /"x": number/u);
  await writeFile(join(directory, "shape.sql"), `SELECT json_transform('{}', '{"x":"VARCHAR"}') AS value`);
  await command(["typed-sql", "generate", "--queries", "--live"]);
  const regenerated = await command(["typed-sql", "check", "--project", "tsconfig.json", "--show-types"]);
  assert.match(regenerated, /"x": string/u);
  assert.notEqual(initial, regenerated);
  await command(["typed-sql", "check", "--project", "tsconfig.json", "--show-types"], true);
  await writeFile(join(artifacts, `${engine}-native-contracts.log`), transcript.join("\n"));
}
