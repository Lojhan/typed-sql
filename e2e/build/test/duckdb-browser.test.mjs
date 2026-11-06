import { describe, it, strict } from "poku";
import { consumer } from "../src/consumer.mjs";

await describe("packed DuckDB browser entrypoint", async () => {
  await it("validates snapshots and analyzes SQL without Node services or aliases", async () => {
    const fixture = await consumer(["esbuild"], ["@typed-sql/schema", "@typed-sql/duckdb"]);
    try {
      const project = await fixture.project("browser-grammar");
      const result = await fixture.node(
        project,
        `
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
const built = await build({bundle:true,write:false,platform:'browser',format:'iife',target:'es2024',
  stdin:{resolveDir:process.cwd(),contents:\`
import {parseSchemaSnapshot} from '@typed-sql/schema/snapshot';
import {duckdb,duckDBServerEvidence} from '@typed-sql/duckdb/browser';
globalThis.duck=duckdb().analyze('SELECT id FROM widgets WHERE id=$1',parseSchemaSnapshot({formatVersion:1,dialect:'duckdb',server:duckDBServerEvidence('2.0.0',[],{currentCatalog:'memory',currentSchema:'main',schema:'main',search_path:'',TimeZone:'UTC',Calendar:'gregorian',integer_division:'false',preserve_identifier_case:'preserve_case',default_null_order:'NULLS_LAST',default_order:'ASCENDING'}),tables:{widgets:{name:'widgets',schema:'main',columns:{id:{name:'id',databaseType:'BIGINT',tsType:'bigint',nullable:false}}}}}));
\`}});
const context={TextEncoder,TextDecoder};
vm.runInNewContext(built.outputFiles[0].text,context,{timeout:5000});
for(const value of [context.duck]) {
const result=JSON.parse(JSON.stringify(value));
assert.deepEqual(result.diagnostics,[]);
assert.equal(result.columns[0].tsType,'bigint');
assert.equal(result.parameters[0].tsType,'bigint');
assert.equal(result.parameters[0].nullable,false);
}
console.log('Packed browser grammar works without Node, driver dependencies or aliases');
`,
      );
      strict.match(result.output, /Packed browser grammar works/u);
    } finally {
      await fixture.close();
    }
  });
});
